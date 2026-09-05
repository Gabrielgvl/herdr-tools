#!/bin/sh
exec /home/gabriel/.hermes/hermes-agent/venv/bin/python -c 'import json; from dotenv import dotenv_values; print(json.dumps({"Authorization": "Bearer " + dotenv_values("/home/gabriel/.hermes/.env")["MCP_EXECUTOR_API_KEY"]}))'
