import { createRouter } from "../lib/httpRouter.js";
import { nanoid } from "../lib/id.js";
import db from "../db/index.js";

export const customersRouter = createRouter();

customersRouter.get("/", (_req, res) => {
  res.json(db.prepare(`SELECT * FROM customers ORDER BY created_at DESC`).all());
});

customersRouter.post("/", (req, res) => {
  const { name, phone, email, tin } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const id = nanoid();
  db.prepare(`INSERT INTO customers (id, name, phone, email, tin) VALUES (?,?,?,?,?)`)
    .run(id, name, phone ?? null, email ?? null, tin ?? null);
  res.status(201).json({ id, name, phone, email, tin });
});

customersRouter.delete("/:id", (req, res) => {
  db.prepare(`DELETE FROM customers WHERE id = ?`).run(req.params.id);
  res.status(204).end();
});
