import { createMcpAdapter } from "pi-mcp-adapter";

export default createMcpAdapter({
  config: {
    settings: {
      toolPrefix: "short",
      idleTimeout: 10,
      scriptMode: false,
    },
    mcpServers: {
      executor: {
        url: "https://dev-server.piranha-palermo.ts.net/mcp",
        headers: {
          Authorization: "!/home/gabriel/.hermes/hermes-agent/venv/bin/python -c 'from dotenv import dotenv_values; print(\"Bearer \" + dotenv_values(\"/home/gabriel/.hermes/.env\")[\"MCP_EXECUTOR_API_KEY\"])'",
        },
        lifecycle: "lazy",
        idleTimeout: 10,
        directTools: ["execute", "skills", "resume"],
        exposeResources: false,
      },
    },
  },
});
