// THROWAWAY PROTOTYPE SERVER. Do not promote this file to production.
const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PROTOTYPE_PORT || 4173);
const htmlPath = path.join(__dirname, "index.html");

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Prototype route not found");
    return;
  }

  fs.readFile(htmlPath, (error, contents) => {
    if (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error.message);
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(contents);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Dashboard prototype: http://127.0.0.1:${port}/?variant=A`);
  console.log("Variants: A Guided run, B Operations console, C Action workspace");
});
