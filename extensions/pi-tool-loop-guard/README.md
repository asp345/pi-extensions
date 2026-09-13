# pi-tool-loop-guard

Blocks runaway tool call loops. When the same tool with identical input has completed 3 times in a row with identical output, the next identical `tool_call` is blocked with an error before execution.

A different tool, input, or output resets the count, so calls that still return new data are never blocked.
