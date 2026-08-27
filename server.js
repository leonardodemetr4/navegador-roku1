const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Navegador Roku</title>
    </head>
    <body>
      <h1>Navegador Roku</h1>
      <p>Servidor online!</p>
    </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "navegador-roku"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Navegador Roku rodando na porta ${PORT}`);
});
