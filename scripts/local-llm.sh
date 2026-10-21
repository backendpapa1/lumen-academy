#!/usr/bin/env bash
# v2 practice mode (VD12): llama.cpp's llama-server with Qwen3-4B on this
# machine's GPU (Vulkan), on 127.0.0.1 only. Downloads live in ~/.cache/lumen.
#   LUMEN_LLAMA_DIR   llama.cpp release dir (default: newest ~/.cache/lumen/llama/llama-b*)
#   LUMEN_LOCAL_MODEL GGUF path (default: Qwen3-4B-Instruct-2507-Q4_K_M)
set -euo pipefail
dir="${LUMEN_LLAMA_DIR:-$(ls -d "$HOME"/.cache/lumen/llama/llama-b* 2>/dev/null | sort -V | tail -1)}"
model="${LUMEN_LOCAL_MODEL:-$HOME/.cache/lumen/models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf}"
[ -x "$dir/llama-server" ] || { echo "llama-server not found; see v2-dev-plan/milestones/V8-platform.md (V8-S1)"; exit 1; }
[ -f "$model" ] || { echo "model not found: $model"; exit 1; }
# Two slots: the crowd reactor and the Director run side by side. Prompt
# caching is on by default, so a class's shared prefix is read once. 8k context
# per slot with an 8-bit KV cache keeps it near 3.5 GB (measured: 32k f16 was 7.4 GB).
exec "$dir/llama-server" -m "$model" --host 127.0.0.1 --port "${LUMEN_LOCAL_PORT:-8091}" \
  -ngl 99 -c 16384 -np 2 -fa on -ctk q8_0 -ctv q8_0 --jinja --alias qwen3-4b-instruct-2507 "$@"
