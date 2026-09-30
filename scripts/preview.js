import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";

const root = fileURLToPath(new URL("../site/", import.meta.url));
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
const port = Number(process.env.PORT || 43189);
const server = createServer(async (request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname); } catch {
    response.writeHead(400).end("Invalid URL");
    return;
  }
  // The extra mount exercises asset paths at a GitHub project subpath.
  pathname = pathname.replace(/^\/microsoftdocs-contributions(?=\/)/, "");
  const file = resolve(root, `.${pathname.endsWith("/") ? `${pathname}index.html` : pathname}`);
  if (!file.startsWith(`${resolve(root)}${sep}`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, { "Content-Type": `${types[extname(file)] || "application/octet-stream"}; charset=utf-8` });
    response.end(data);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") response.writeHead(404).end("Not found");
    else {
      console.error(error);
      response.writeHead(500).end("Preview server failed");
    }
  }
});
server.listen(port, "127.0.0.1", () => console.log(`Preview: http://127.0.0.1:${port}`));
