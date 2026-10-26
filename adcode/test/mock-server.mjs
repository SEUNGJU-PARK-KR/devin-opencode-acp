// Minimal OpenAI-compatible SSE mock for manual ACP testing.
// First request -> a read_file tool call; after the tool result -> a text reply.
import { createServer } from "node:http";

let body = "";
const readBody = (req) =>
  new Promise((res) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => res(d));
  });

createServer(async (req, res) => {
  if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
    const payload = JSON.parse(await readBody(req));
    const hasToolResult = payload.messages?.some((m) => m.role === "tool");
    res.writeHead(200, { "content-type": "text/event-stream" });
    const say = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    say({ role: "assistant", content: "" });
    if (!hasToolResult) {
      say({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "README.md", limit: 3 }) },
          },
        ],
      }, "tool_calls");
    } else {
      for (const chunk of ["I read ", "the file ", "for you."]) say({ content: chunk });
      say({}, "stop");
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  res.writeHead(404).end();
}).listen(11434, "127.0.0.1", () => console.error("mock on :11434"));
