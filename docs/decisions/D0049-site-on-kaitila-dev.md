# D0049: The landing page lives at cleat.kaitila.dev, on Cloudflare

Date: 2026-11-24. Status: active. No foreman task (asked for in a session by the owner). Changes where [D0047](D0047-one-line-install-script.md)'s install script is served; the page itself is [D0041](D0041-landing-page-one-screen.md).

## Context
The owner, on 2026-11-24: "can you connect to my cloudflare console and deploy this under my kaitila.dev domain". The site was served only by GitHub Pages, at kaitila.github.io/cleat, which also served the install line's script.

## Decision
- **https://cleat.kaitila.dev/** serves the landing page and `install.sh`. The install line is `curl -fsSL https://cleat.kaitila.dev/install.sh | sh` in the README, docs/platforms.md, the page and the script's own comment.
- **A static Worker, not a Pages project.** `bun scripts/deploy-site.ts` builds the site into a temporary folder, writes a Workers config there (assets only, `workers_dev: false`, the custom domain `cleat.kaitila.dev`) and runs `bunx wrangler deploy`. The Worker is `cleat-site` in the owner's account; Cloudflare made the domain's DNS record and certificate itself.
- **wrangler is not a dependency.** bunx fetches it; the machine needs `bunx wrangler login` once. Nothing of wrangler's is kept in the repo.
- **GitHub Pages stays** as a second address for the same site (pages.yml), so the old line keeps working.
- **Deploys are by hand for now**, after a change under site/: a workflow can't be added from here (the GitHub token has no `workflow` scope), and a Cloudflare API token would have to be a repository secret.

## Why
- **A Worker's custom domain** makes its own DNS record. wrangler's login can't write DNS records, so a Pages project's custom domain stayed "pending: CNAME record not set".
- **A subdomain** leaves kaitila.dev itself free for anything else.

## Risk
- The two addresses can differ until someone runs the deploy after a change under site/.
