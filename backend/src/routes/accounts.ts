import { createRouter } from "../lib/httpRouter.js";
import { nanoid } from "../lib/id.js";
import db from "../db/index.js";

export const accountsRouter = createRouter();

accountsRouter.get("/", (_req, res) => {
  const rows = db.prepare(`SELECT * FROM accounts ORDER BY code`).all();
  res.json(rows);
});

accountsRouter.post("/", (req, res) => {
  const { code, name, type } = req.body ?? {};
  if (!code || !name || !type) return res.status(400).json({ error: "code, name, type are required" });
  const id = nanoid();
  db.prepare(`INSERT INTO accounts (id, code, name, type) VALUES (?,?,?,?)`).run(id, code, name, type);
  res.status(201).json({ id, code, name, type });
});
