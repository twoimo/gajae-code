# Ralplan Routing

This dispatcher is routing-only. Runtime state selects the matching phase fragment; only that fragment supplies workflow instructions.

Use the current-session state to resume the selected phase. When state is absent, invalid, or cannot be read, surface the workflow recovery status and do not provide phase instructions.
