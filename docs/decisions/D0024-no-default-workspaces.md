# D0024: A new config has no workspaces

Date: 2026-11-15. Status: active.

## Context
The owner decided on 2026-11-15 to make the repository public, installed by cloning and running `intuition setup`. The config file the runner wrote on its first run named two folders of the owner's machine as workspaces, and the schema refused a config with none, so a stranger's first run started with workspaces that were not theirs (T-0037).

## Decision
- `DEFAULT_CONFIG` has `workspaces: []`. The first run writes that; `intuition setup` and the Settings window add the folders.
- The schema takes an empty list, in the file and in `PUT /api/settings`. A list of workspaces is still checked as before (names unique, paths absolute and existing).
- With no workspace to pick, the pop-up and the snip say "no workspaces yet: add one in Settings, from the tray menu"; with workspaces whose folders are all missing, they say to fix the paths in Settings. Starting a session in a workspace that isn't listed is still a 400.

## Why
- A made-up default (`~/projects`, say) would be a folder most people don't have, shown as missing; none says plainly what to do.
- Refusing an empty list in the PUT would leave the person unable to remove their last workspace while the file itself may have none, so the two would disagree. One schema for both (D0022) keeps them the same.
