import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = 4173;
const contentTypes = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".woff2", "font/woff2"]
]);

const server = createServer(async (request, response) => {
    let requestPath;
    try {
        requestPath = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    } catch {
        response.writeHead(400).end("Bad request");
        return;
    }

    const relativePath = requestPath === "/" ? "preview.html" : requestPath.slice(1);
    const filePath = resolve(join(root, relativePath));
    const relativeToRoot = relative(root, filePath);
    if (relativeToRoot.startsWith("..") || relativeToRoot.includes(":")) {
        response.writeHead(403).end("Forbidden");
        return;
    }

    try {
        const fileInfo = await stat(filePath);
        if (!fileInfo.isFile()) {
            response.writeHead(404).end("Not found");
            return;
        }
        response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Length": fileInfo.size,
            "Content-Type": contentTypes.get(extname(filePath)) ?? "application/octet-stream",
            "X-Content-Type-Options": "nosniff"
        });
        createReadStream(filePath).pipe(response);
    } catch (error) {
        if (error.code === "ENOENT") {
            response.writeHead(404).end("Not found");
            return;
        }
        console.error("Preview request failed:", error.message);
        response.writeHead(500).end("Preview request failed");
    }
});

server.listen(port, "127.0.0.1", () => {
    console.log(`Preview ready at http://127.0.0.1:${port}/`);
});

process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
});
