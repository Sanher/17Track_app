const express = require("express");

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// placeholder
app.get("/api/carriers", (_req, res) => res.json({ carriers_map: {} }));

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`17Track app listening on ${port}`);
});
