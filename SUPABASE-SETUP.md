# GitHub Pages and Supabase setup

GitHub Pages hosts the public storefront. Supabase provides the shared catalog database, administrator sign-in, and image storage. The Supabase project URL and **anon/publishable key** are public client configuration; never put a service-role key in a website file or commit one to GitHub.

## 1. Create the Supabase catalog

1. Create a Supabase project and open **SQL Editor**.
2. Run the contents of `supabase-schema.sql`. This creates the catalog tables, public read access for visible items, admin-only catalog changes, and the public image bucket with admin-only uploads.
3. In **Authentication → Users**, create an administrator account with an email and password. Do not enable public sign-up for the site.
4. Copy that user's UUID. In SQL Editor, authorize the account:

   ```sql
   insert into public.admin_users (user_id)
   values ('PASTE-AUTH-USER-UUID-HERE');
   ```

   Only UUIDs listed in `admin_users` can manage the catalog. Supabase row-level security enforces this even if someone changes the browser code.

## 2. Migrate the existing local catalog

Run this once from the project folder. It prompts for the project URL and a service-role key without echoing or saving the key, refuses to duplicate a non-empty cloud catalog, and transfers local images to the `catalog-images` bucket.

```powershell
.\.venv\Scripts\python.exe .\migrate_catalog_to_supabase.py
```

Keep the service-role key private. Never add it to `supabase-config.js`, HTML, JavaScript, or GitHub.

## 3. Configure the public website

Edit `supabase-config.js` and set the project's URL and anon/publishable key:

```js
window.ITECH_SUPABASE_CONFIG = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'YOUR-SUPABASE-ANON-OR-PUBLISHABLE-KEY'
};
```

The anon/publishable key is intended for browser use; database and storage policies protect the data. Never use the service-role/secret key here.

## 4. Publish on GitHub Pages

1. Commit and push the site files, including `supabase-config.js`, `supabase-client.js`, and `supabase-schema.sql`.
2. In the GitHub repository, open **Settings → Pages** and publish from the desired branch and folder.
3. In Supabase **Authentication → URL Configuration**, set the Site URL to the published GitHub Pages address and add that address to the redirect URL allow list.
4. Visit the published site. The storefront reads visible catalog items from Supabase. Open `admin.html`, sign in with the authorized administrator email/password, and edit the shared catalog.

The local `start-local.bat` workflow and local catalog remain available when `supabase-config.js` has empty values. Cloud catalog changes are shared by all visitors; the local SQLite database and the Supabase catalog are separate.
