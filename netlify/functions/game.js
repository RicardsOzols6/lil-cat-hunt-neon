// netlify/functions/game.js
import { neon } from "@neondatabase/serverless";

const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  process.env.NEON_DATABASE_URL ||
  process.env.NETLIFY_DATABASE_URL;

const corsHeaders = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const ok = (body) => ({
  statusCode: 200,
  headers: corsHeaders,
  body: JSON.stringify(body),
});

const err = (statusCode, message) => ({
  statusCode,
  headers: corsHeaders,
  body: JSON.stringify({ error: message }),
});

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return ok({ ok: true });

  if (!CONNECTION_STRING) {
    return err(500, "Missing DATABASE_URL / NETLIFY_DATABASE_URL");
  }

  try {
    const sql = neon(CONNECTION_STRING);

    // Ensure table exists
    await sql`
      create table if not exists cat_game (
        id text primary key,
        found int not null default 0,
        total int not null default 0,
        game_name text not null default '🐾 Lil Cat Hunt 🐾',
        hidden_cats jsonb not null default '[]'::jsonb,
        history jsonb not null default '[]'::jsonb,
        updated_at timestamptz not null default now()
      )
    `;

    const id = "default";

    if (event.httpMethod === "GET") {
      const rows = await sql`select * from cat_game where id = ${id}`;
      if (rows.length === 0) {
        const seed = {
          id,
          found: 0,
          total: 0,
          game_name: "🐾 Lil Cat Hunt 🐾",
          hidden_cats: [],
          history: [],
        };
        await sql`
          insert into cat_game (id, found, total, game_name, hidden_cats, history)
          values (${id}, ${seed.found}, ${seed.total}, ${seed.game_name},
                  ${JSON.stringify(seed.hidden_cats)}::jsonb,
                  ${JSON.stringify(seed.history)}::jsonb)
          on conflict (id) do nothing
        `;
        return ok(seed);
      }
      const r = rows[0];
      return ok({
        id: r.id,
        found: r.found,
        total: r.total,
        game_name: r.game_name,
        hidden_cats: r.hidden_cats,
        history: r.history,
        updated_at: r.updated_at,
      });
    }

    if (event.httpMethod === "POST") {
      let payload;
      try {
        payload = JSON.parse(event.body || "{}");
      } catch {
        return err(400, "Invalid JSON");
      }
      const s = payload?.state || {};
      const found = Number.isFinite(s.found) ? s.found : 0;
      const total = Number.isFinite(s.total) ? s.total : 0;
      const game_name =
        typeof s.game_name === "string" ? s.game_name : "🐾 Lil Cat Hunt 🐾";
      const hidden_cats = Array.isArray(s.hidden_cats) ? s.hidden_cats : [];
      const history = Array.isArray(s.history) ? s.history : [];

      const rows = await sql`
        insert into cat_game (id, found, total, game_name, hidden_cats, history, updated_at)
        values (${id}, ${found}, ${total}, ${game_name},
                ${JSON.stringify(hidden_cats)}::jsonb,
                ${JSON.stringify(history)}::jsonb, now())
        on conflict (id) do update set
          found = excluded.found,
          total = excluded.total,
          game_name = excluded.game_name,
          hidden_cats = excluded.hidden_cats,
          history = excluded.history,
          updated_at = now()
        returning id, found, total, game_name, hidden_cats, history, updated_at
      `;
      return ok(rows[0]);
    }

    return err(405, "Method not allowed");
  } catch (e) {
    console.error(e);
    return err(500, String(e && e.message ? e.message : e));
  }
}
