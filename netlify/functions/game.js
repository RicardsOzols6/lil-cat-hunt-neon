// netlify/functions/game.js
import { neon } from "@neondatabase/serverless";

const CONN =
  process.env.DATABASE_URL ||
  process.env.NEON_DATABASE_URL ||
  process.env.NETLIFY_DATABASE_URL;

const cors = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

const ok = (body) => ({ statusCode: 200, headers: cors, body: JSON.stringify(body) });
const err = (code, msg) => ({ statusCode: code, headers: cors, body: JSON.stringify({ error: msg }) });

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") return ok({ ok: true });
  if (!CONN) return err(500, "Missing DATABASE_URL / NETLIFY_DATABASE_URL");

  try {
    const sql = neon(CONN);
    // Tables
    await sql`
      create table if not exists cat_game (
        id text primary key,
        found int not null default 0,
        total int not null default 0,
        game_name text not null default '🐾 Lil Cat Hunt 🐾',
        hidden_cats jsonb not null default '[]'::jsonb,
        history jsonb not null default '[]'::jsonb,
        updated_at timestamptz not null default now()
      );
      create table if not exists cat_rules (
        color text not null,
        location text not null,
        name text not null,
        priority int not null default 0,
        primary key (color, location)
      );
    `;

    const id = "default";

    // Helpers
    const getState = async () => {
      const rows = await sql`select * from cat_game where id = ${id}`;
      if (rows.length) return rows[0];
      const seed = {
        id, found: 0, total: 0, game_name: "🐾 Lil Cat Hunt 🐾",
        hidden_cats: [], history: []
      };
      await sql`
        insert into cat_game (id, found, total, game_name, hidden_cats, history)
        values (${id}, ${seed.found}, ${seed.total}, ${seed.game_name},
                ${JSON.stringify(seed.hidden_cats)}::jsonb,
                ${JSON.stringify(seed.history)}::jsonb)
        on conflict (id) do nothing
      `;
      return seed;
    };

    const saveState = async (s) => {
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

    const suggestName = async (color, location) => {
      const rows = await sql`
        select name from cat_rules
        where lower(color)=lower(${color}) and lower(location)=lower(${location})
        order by priority desc limit 1
      `;
      return rows.length ? rows[0].name : null;
    };

    // ROUTES
    if (event.httpMethod === "GET") {
      const s = await getState();
      return ok({
        id: s.id, found: s.found, total: s.total,
        game_name: s.game_name, hidden_cats: s.hidden_cats, history: s.history,
        updated_at: s.updated_at
      });
    }

    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); } catch { return err(400, "Invalid JSON"); }
      const action = body.action;

      // Optional: seed a few defaults
      if (action === "seedRules") {
        const defaults = [
          // color + location -> name (edit freely!)
          ["Black","Kitchen","Shadow"],
          ["Orange","Kitchen","Marmalade"],
          ["Beige","Kitchen","Latte"],
          ["Black","Emyl’s Bathroom","Ink"],
          ["Orange","Emyl’s Bathroom","Goldie"],
          ["Beige","Emyl’s Bathroom","Sandie"],
          ["Black","Richards Bathroom","Soot"],
          ["Orange","Richards Bathroom","Tiger"],
          ["Beige","Richards Bathroom","Biscuit"],
          ["Black","Emyl’s Room","Midnight"],
          ["Orange","Emyl’s Room","Sunny"],
          ["Beige","Emyl’s Room","Tofu"],
          ["Black","Richards Room","Licorice"],
          ["Orange","Richards Room","Flame"],
          ["Beige","Richards Room","Cashew"],
          ["Black","Storage Room 1","Charcoal"],
          ["Orange","Storage Room 1","Apricot"],
          ["Beige","Storage Room 1","Almond"],
          ["Black","Storage Room 2","Onyx"],
          ["Orange","Storage Room 2","Paprika"],
          ["Beige","Storage Room 2","Oat"],
          ["Black","Hallway","Ninja"],
          ["Orange","Hallway","Fanta"],
          ["Beige","Hallway","Waffle"],
        ];
        for (const [c,l,n] of defaults) {
          await sql`insert into cat_rules (color, location, name) values (${c}, ${l}, ${n})
                    on conflict (color,location) do update set name=excluded.name`;
        }
        return ok({ seeded: defaults.length });
      }

      // Add hidden: color/location/name? (name optional → use rules)
      if (action === "addHidden") {
        const { color, location } = body;
        let name = body.name;
        if (!name) name = (await suggestName(color, location)) || `Cat #${Date.now()%10000}`;
        const s = await getState();
        const cat = { id: Date.now(), name, color, location, found: false };
        s.hidden_cats = [...s.hidden_cats, cat];
        s.total += 1;
        s.history = [{ type:"total+", delta:1, where:location, color, name, when:new Date().toISOString() }, ...s.history].slice(0,200);
        const ns = await saveState(s);
        return ok({ ...ns, assignedName: name });
      }

      // Found: color/location → resolve name via rules; mark found
      if (action === "found") {
        const { color, location } = body;
        const s = await getState();
        // Try match an existing hidden cat with same color+location not yet found
        let foundIndex = s.hidden_cats.findIndex(c => !c.found && eq(c.color,color) && eq(c.location,location));
        const assign = async () => (await suggestName(color, location)) || `Cat #${s.found+1}`;
        const name = foundIndex >= 0
          ? (s.hidden_cats[foundIndex].name || await assign())
          : await assign();

        if (foundIndex >= 0) {
          s.hidden_cats[foundIndex] = { ...s.hidden_cats[foundIndex], name, found:true, found_at:new Date().toISOString() };
        } else {
          // not pre-added → add as ad-hoc found cat but do not change total
          s.hidden_cats = [{ id: Date.now(), name, color, location, found:true, found_at:new Date().toISOString() }, ...s.hidden_cats];
        }
        s.found += 1;
        s.history = [{ type:"found+", name, where:location, color, delta:1, when:new Date().toISOString() }, ...s.history].slice(0,200);
        const ns = await saveState(s);
        return ok({ ...ns, assignedName: name });
      }

      return err(400, "Unknown action");
    }

    return err(405, "Method not allowed");
  } catch (e) {
    console.error(e);
    return err(500, String(e?.message || e));
  }
}

function eq(a,b){ return String(a||"").toLowerCase() === String(b||"").toLowerCase(); }
