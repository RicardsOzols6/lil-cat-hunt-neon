// netlify/functions/game.js
import { neon } from "@neondatabase/serverless";

const CONN =
  process.env.DATABASE_URL ||
  process.env.NEON_DATABASE_URL ||
  process.env.NETLIFY_DATABASE_URL;

const ADMIN_CODE = process.env.ADMIN_CODE || "";

const cors = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const ok = (body) => ({ statusCode: 200, headers: cors, body: JSON.stringify(body) });
const err = (code, msg) => ({ statusCode: code, headers: cors, body: JSON.stringify({ error: msg }) });

const nowISO = () => new Date().toISOString();
const eq = (a,b)=> String(a||"").toLowerCase() === String(b||"").toLowerCase();

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return ok({ ok: true });
  if (!CONN) return err(500, "Missing DATABASE_URL / NETLIFY_DATABASE_URL");

  try {
    const isAdmin = (() => {
      const p = event.queryStringParameters || {};
      return ADMIN_CODE ? p.admin === ADMIN_CODE : false;
    })();

    const sql = neon(CONN);

    await sql`create table if not exists cat_game (
      id text primary key,
      found int not null default 0,
      total int not null default 0,
      game_name text not null default '🐾 Lil Cat Hunt 🐾',
      hidden_cats jsonb not null default '[]'::jsonb,
      history jsonb not null default '[]'::jsonb,
      updated_at timestamptz not null default now()
    )`;

    const id = "default";

    const getState = async () => {
      const rows = await sql`select * from cat_game where id = ${id}`;
      if (rows.length) return rows[0];
      const seed = {
        id, found: 0, total: 0, game_name: "🐾 Lil Cat Hunt 🐾",
        hidden_cats: [], history: [], updated_at: nowISO()
      };
      await sql`
        insert into cat_game (id, found, total, game_name, hidden_cats, history, updated_at)
        values (${id}, ${seed.found}, ${seed.total}, ${seed.game_name},
                ${JSON.stringify(seed.hidden_cats)}::jsonb,
                ${JSON.stringify(seed.history)}::jsonb, ${seed.updated_at})
        on conflict (id) do nothing
      `;
      return seed;
    };

    const normalizeCounts = (s) => {
      const cats = s.hidden_cats || [];
      s.total = cats.length;
      s.found = cats.filter(c => c.found).length;
      return s;
    };

    const saveState = async (s) => {
      normalizeCounts(s);
      const rows = await sql`
        insert into cat_game (id, found, total, game_name, hidden_cats, history, updated_at)
        values (${id}, ${s.found}, ${s.total}, ${s.game_name},
                ${JSON.stringify(s.hidden_cats)}::jsonb,
                ${JSON.stringify(s.history)}::jsonb, now())
        on conflict (id) do update set
          found = excluded.found,
          total = excluded.total,
          game_name = excluded.game_name,
          hidden_cats = excluded.hidden_cats,
          history = excluded.history,
          updated_at = now()
        returning *
      `;
      return rows[0];
    };

    const maskForPlayer = (state) => {
      const HIDDEN = "🫥 Hidden";
      const s = structuredClone(state);
      if (!isAdmin) {
        s.hidden_cats = (s.hidden_cats || []).map(c => c.found ? c : { ...c, name: HIDDEN });
        s.history = (s.history || []).map(h => (h.type === "found+") ? h : { ...h, name: HIDDEN });
      }
      return s;
    };

    const pickCandidateIndex = (cats, color, location) => {
      let i = cats.findIndex(c => !c.found && eq(c.color,color) && eq(c.location,location));
      if (i >= 0) return i;
      i = cats.findIndex(c => !c.found && eq(c.color,color)); if (i >= 0) return i;
      i = cats.findIndex(c => !c.found && eq(c.location,location)); if (i >= 0) return i;
      return -1; // ← no more “ad-hoc” guesses; must be an existing hidden cat
    };

    if (event.httpMethod === "GET") {
      const raw = await getState();
      normalizeCounts(raw);
      return ok(maskForPlayer(raw));
    }

    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return err(400, "Invalid JSON"); }
      const action = body.action;

      const s = await getState();
      normalizeCounts(s);

      // Admin-only actions
      if (["addHidden","deleteCat","clearHistory","renameGame"].includes(action) && !isAdmin) {
        return err(403, "Admin required");
      }

      if (action === "renameGame") {
        s.game_name = String(body.name || s.game_name).slice(0, 60);
        const ns = await saveState(s);
        return ok(maskForPlayer(ns));
      }

      if (action === "addHidden") {
        const { color, location } = body;
        let name = body.name?.trim();
        if (!color || !location) return err(400, "color & location required");
        if (!name) name = `🫥 Hidden`;
        const cat = { id: Date.now(), name, color, location, found: false, created_at: nowISO() };
        s.hidden_cats = [...(s.hidden_cats||[]), cat];
        s.history = [
          { type:"total+", delta:1, where:location, color, name: cat.name, when: nowISO() },
          ...(s.history||[])
        ].slice(0, 200);
        const ns = await saveState(s);
        return ok(maskForPlayer(ns));
      }

      if (action === "deleteCat") {
        const { id: cid } = body;
        const idx = (s.hidden_cats||[]).findIndex(c => c.id === cid);
        if (idx === -1) return err(404, "Cat not found");
        s.hidden_cats.splice(idx,1);
        s.history = [{ type:"delete", id: cid, when: nowISO() }, ...(s.history||[])].slice(0,200);
        const ns = await saveState(s);
        return ok(maskForPlayer(ns));
      }

      if (action === "clearHistory") {
        s.history = [];
        const ns = await saveState(s);
        return ok(maskForPlayer(ns));
      }

      if (action === "found") {
        const { color, location } = body;
        const cats = s.hidden_cats || [];
        const idx = pickCandidateIndex(cats, color, location);
        if (idx === -1) return err(409, "No matching hidden cats. Ask Emyl to add some! 🐱");

        const chosen = cats[idx];
        s.hidden_cats[idx] = { ...chosen, found: true, found_at: nowISO() };
        s.history = [
          { type:"found+", delta:1, where: chosen.location, color: chosen.color, name: chosen.name, when: nowISO() },
          ...(s.history||[])
        ].slice(0,200);

        const ns = await saveState(s);
        return ok(maskForPlayer(ns));
      }

      return err(400, "Unknown action");
    }

    return err(405, "Method not allowed");
  } catch (e) {
    console.error(e);
    return err(500, String(e?.message || e));
  }
}
