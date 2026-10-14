import path from "node:path";
const root = path.resolve(import.meta.dir, "../dist");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4173),
  async fetch(request) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (pathname.endsWith("/")) pathname += "index.html";
    else if (pathname === "/admin") pathname = "/admin/index.html";
    const filePath = path.resolve(root, "." + pathname);
    if (!filePath.startsWith(root + path.sep))
      return new Response("Not found", { status: 404 });
    const file = Bun.file(filePath);
    return (await file.exists())
      ? new Response(file)
      : new Response("Not found", { status: 404 });
  },
});
console.log("Static preview: " + server.url);
