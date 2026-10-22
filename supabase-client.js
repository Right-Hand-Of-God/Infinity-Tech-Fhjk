(() => {
  const config = window.ITECH_SUPABASE_CONFIG || {};
  const baseUrl = String(config.url || '').replace(/\/+$/, '');
  const anonKey = String(config.anonKey || '');
  const storageKey = 'itech-supabase-session';
  const bucket = 'catalog-images';

  function isConfigured() {
    return Boolean(baseUrl && anonKey);
  }

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || 'null');
    } catch (error) {
      console.error('Could not read the saved Supabase session:', error);
      return null;
    }
  }

  function saveSession(session) {
    if (session) localStorage.setItem(storageKey, JSON.stringify(session));
    else localStorage.removeItem(storageKey);
  }

  async function request(path, options = {}, token = '') {
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          apikey: anonKey,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...options.headers
        }
      });
    } catch {
      throw new Error('Could not connect to Supabase. Check the project URL and network connection.');
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const message = data && (data.message || data.msg || data.error_description || data.error);
      throw new Error(message || `Supabase request failed (${response.status}).`);
    }
    return data;
  }

  async function currentSession() {
    const session = readSession();
    if (!session) return null;
    if (session.expires_at && session.expires_at * 1000 > Date.now() + 60_000) return session;
    if (!session.refresh_token) {
      saveSession(null);
      return null;
    }
    try {
      const refreshed = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      refreshed.expires_at = Math.floor(Date.now() / 1000) + (refreshed.expires_in || 3600);
      saveSession(refreshed);
      return refreshed;
    } catch (error) {
      saveSession(null);
      throw error;
    }
  }

  async function authenticatedRequest(path, options = {}) {
    const session = await currentSession();
    if (!session?.access_token) throw new Error('Please sign in to manage the catalog.');
    return request(path, options, session.access_token);
  }

  async function signIn(email, password) {
    const session = await request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    session.expires_at = Math.floor(Date.now() / 1000) + (session.expires_in || 3600);
    saveSession(session);
    return session;
  }

  async function signOut() {
    try {
      const session = await currentSession();
      if (session?.access_token) {
        await request('/auth/v1/logout', { method: 'POST' }, session.access_token);
      }
    } finally {
      saveSession(null);
    }
  }

  async function isAdmin() {
    const session = await currentSession();
    if (!session?.user?.id) return false;
    const rows = await authenticatedRequest(
      `/rest/v1/admin_users?select=user_id&user_id=eq.${encodeURIComponent(session.user.id)}`
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  async function fetchItems(admin = false) {
    const query = admin
      ? 'select=*&order=id.desc'
      : 'select=*&visible=eq.true&order=id.desc';
    const path = `/rest/v1/catalog_items?${query}`;
    return admin
      ? authenticatedRequest(path)
      : request(path);
  }

  async function saveItem(item, id = null) {
    const path = id
      ? `/rest/v1/catalog_items?id=eq.${encodeURIComponent(id)}`
      : '/rest/v1/catalog_items';
    return authenticatedRequest(path, {
      method: id ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation'
      },
      body: JSON.stringify(item)
    });
  }

  async function deleteItem(id) {
    return authenticatedRequest(`/rest/v1/catalog_items?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  }

  async function uploadImage(file) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const objectPath = `${crypto.randomUUID()}-${safeName}`;
    await authenticatedRequest(`/storage/v1/object/${bucket}/${objectPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type,
        'x-upsert': 'false'
      },
      body: file
    });
    return `${baseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
  }

  window.itechSupabase = {
    isConfigured,
    currentSession,
    signIn,
    signOut,
    isAdmin,
    fetchItems,
    saveItem,
    deleteItem,
    uploadImage
  };
})();
