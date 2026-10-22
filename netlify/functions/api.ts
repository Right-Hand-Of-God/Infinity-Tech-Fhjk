import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { desc, eq, lt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { adminSessions, catalogItems } from "../../db/schema.js";

const SESSION_COOKIE = "itech_admin";
const SESSION_LIFETIME_SECONDS = 12 * 60 * 60;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// The owner can override this by setting ADMIN_PASSWORD in the Netlify environment variables.
const DEFAULT_ADMIN_PASSWORD = "Itechfix";

const ALLOWED_CATEGORIES = new Set([
  "home-showcase",
  "phone-sales",
  "phone-repairs",
  "laptop-sales",
  "laptop-repairs",
  "gadgets",
  "phone-parts",
]);
const ALLOWED_PART_CATEGORIES = new Set([
  "Displays",
  "Batteries",
  "Charging ports",
  "Cameras",
  "Flex cables",
  "Motherboards & ICs",
  "Audio",
  "Tools",
  "Accessories",
]);
const ALLOWED_TARGETS = new Set(["phones", "repairs", "laptops", "gadgets"]);
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

type CatalogRow = typeof catalogItems.$inferSelect;

function json(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function publicItem(row: CatalogRow) {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    description: row.description,
    price: row.price,
    model: row.model,
    part_category: row.partCategory,
    target: row.target,
    stock: row.stock,
    image: row.image,
    visible: row.visible,
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest();
}

function readSessionToken(req: Request) {
  const cookie = req.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return "";
}

async function isAuthenticated(req: Request) {
  const token = readSessionToken(req);
  if (!token) return false;
  const [session] = await db
    .select()
    .from(adminSessions)
    .where(eq(adminSessions.tokenHash, sha256(token).toString("hex")));
  return Boolean(session && session.expiresAt.getTime() > Date.now());
}

function sessionCookie(token: string, maxAge: number) {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

async function login(req: Request) {
  const data = await req.json().catch(() => null);
  const password = data && typeof data.password === "string" ? data.password : "";
  const expected = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
  if (!timingSafeEqual(sha256(password), sha256(expected))) {
    return json({ error: "Password is incorrect." }, 401);
  }
  await db.delete(adminSessions).where(lt(adminSessions.expiresAt, new Date()));
  const token = randomBytes(32).toString("base64url");
  await db.insert(adminSessions).values({
    tokenHash: sha256(token).toString("hex"),
    expiresAt: new Date(Date.now() + SESSION_LIFETIME_SECONDS * 1000),
  });
  return json({ ok: true, role: "owner" }, 200, {
    "Set-Cookie": sessionCookie(token, SESSION_LIFETIME_SECONDS),
  });
}

async function logout(req: Request) {
  const token = readSessionToken(req);
  if (token) {
    await db.delete(adminSessions).where(eq(adminSessions.tokenHash, sha256(token).toString("hex")));
  }
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
}

function hasImageSignature(type: string, bytes: Uint8Array) {
  const startsWith = (signature: number[], offset = 0) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (type === "image/jpeg") return startsWith([0xff, 0xd8, 0xff]);
  if (type === "image/png") return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (type === "image/webp") return startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8);
  if (type === "image/gif") return startsWith([0x47, 0x49, 0x46, 0x38]);
  return false;
}

async function uploadImage(req: Request) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("image");
  if (!file || typeof file === "string") {
    return json({ error: "Choose an image file to upload." }, 400);
  }
  const type = file.type.toLowerCase();
  const extension = ALLOWED_IMAGE_TYPES[type];
  if (!extension || file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    return json({ error: "Use a JPEG, PNG, WEBP, or GIF image under 8 MB." }, 400);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasImageSignature(type, bytes)) {
    return json({ error: "Image contents do not match the selected image format." }, 400);
  }
  const key = randomBytes(16).toString("hex") + extension;
  await getStore("catalog-images").set(key, bytes.buffer as ArrayBuffer, { metadata: { contentType: type } });
  return json({ image: `/uploads/${key}` }, 201);
}

function validateItem(data: any): { error: string } | { values: typeof catalogItems.$inferInsert } {
  if (!data || typeof data !== "object") return { error: "Request body must be a JSON object." };
  const {
    category = "",
    title = "",
    description = "",
    price = "",
    model = "",
    part_category: partCategory = "Accessories",
    target = "phones",
    stock = "",
    image = "",
    visible = true,
  } = data;
  if (!ALLOWED_CATEGORIES.has(category)) return { error: "Choose a valid catalog section." };
  if (!ALLOWED_PART_CATEGORIES.has(partCategory)) return { error: "Choose a valid spare-part category." };
  if (!ALLOWED_TARGETS.has(target)) return { error: "Choose a valid storefront destination." };
  if (typeof title !== "string" || !title.trim() || title.length > 120) {
    return { error: "Title is required and must be 120 characters or fewer." };
  }
  const limits: [string, unknown, number][] = [
    ["Description", description, 2000],
    ["Price", price, 80],
    ["Model", model, 120],
    ["Stock", stock, 80],
    ["Image", image, 250],
  ];
  for (const [name, value, limit] of limits) {
    if (typeof value !== "string" || value.length > limit) return { error: `${name} is invalid or too long.` };
  }
  if (category === "phone-parts") {
    const numericPrice = Number(String(price).replace(/[,₦\s]/g, ""));
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) {
      return { error: "Spare-part listings need a numeric price greater than zero." };
    }
  }
  const validImage =
    !image ||
    /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|gif)$/.test(image) ||
    /^[\w .&()-]+\.(jpe?g|png|webp|gif)$/i.test(image);
  if (!validImage) return { error: "Select an existing storefront image or upload a new one." };
  if (typeof visible !== "boolean") return { error: "Visibility must be true or false." };
  return {
    values: {
      category,
      title: title.trim(),
      description: description.trim(),
      price: price.trim(),
      model: model.trim(),
      partCategory,
      target,
      stock: stock.trim(),
      image,
      visible,
    },
  };
}

async function saveItem(req: Request, id: number | null) {
  const result = validateItem(await req.json().catch(() => null));
  if ("error" in result) return json({ error: result.error }, 400);
  if (id === null) {
    const [row] = await db.insert(catalogItems).values(result.values).returning();
    return json(publicItem(row), 201);
  }
  const [row] = await db.update(catalogItems).set(result.values).where(eq(catalogItems.id, id)).returning();
  if (!row) return json({ error: "Listing not found." }, 404);
  return json(publicItem(row));
}

async function deleteItem(id: number) {
  const [row] = await db.delete(catalogItems).where(eq(catalogItems.id, id)).returning();
  if (!row) return json({ error: "Listing not found." }, 404);
  return json({ ok: true });
}

function isSameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  return !origin || new URL(origin).host === new URL(req.url).host;
}

export default async (req: Request) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const method = req.method;

  try {
    if (method === "GET" && path === "/api/status") {
      return json({ setup_required: false, authenticated: await isAuthenticated(req), role: "owner" });
    }
    if (method === "GET" && path === "/api/items") {
      const rows = await db
        .select()
        .from(catalogItems)
        .where(eq(catalogItems.visible, true))
        .orderBy(desc(catalogItems.id));
      return json(rows.map(publicItem));
    }

    if (method !== "GET" && !isSameOrigin(req)) {
      return json({ error: "Cross-origin changes are not allowed." }, 403);
    }
    if (method === "POST" && path === "/api/login") return login(req);
    if (method === "POST" && path === "/api/logout") return logout(req);

    if (!(await isAuthenticated(req))) {
      return json({ error: "Please sign in to manage the catalog." }, 401);
    }
    if (method === "GET" && path === "/api/admin/items") {
      const rows = await db.select().from(catalogItems).orderBy(desc(catalogItems.id));
      return json(rows.map(publicItem));
    }
    if (method === "POST" && path === "/api/upload") return uploadImage(req);
    if (method === "POST" && path === "/api/items") return saveItem(req, null);

    const itemMatch = path.match(/^\/api\/items\/(\d+)$/);
    if (itemMatch) {
      const id = Number(itemMatch[1]);
      if (method === "PUT") return saveItem(req, id);
      if (method === "DELETE") return deleteItem(id);
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    console.error("Catalog API error:", error);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};

export const config: Config = {
  path: ["/api/*"],
};
