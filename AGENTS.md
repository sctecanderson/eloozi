# Eloozi: design and implementation guidance

Preserve the current Eloozi brand, product behavior, React, TypeScript, Vite, Tailwind, Supabase configuration, and existing component libraries. Do not redesign, replace dependencies, or alter business/data rules unless the user explicitly requests that work.

Choose one primary design skill for each task. Do not load overlapping design skills together unless the request clearly spans their scopes:

- `ui-ux-pro-max`: product design systems and product screens. Treat suggestions as guidance; retain existing Eloozi tokens and visual identity unless redesign is requested.
- `design-taste-frontend`: public landing pages and commercial pages. Its page-specific house rules do not override Eloozi brand or user constraints.
- `design-motion-principles`: microinteractions, transitions, and animation audits. Respect `prefers-reduced-motion` and keep frequent restaurant workflows fast.
- `frontend-design` and `impeccable`: visual exploration or broad polish only when specifically requested; do not run alongside the primary skill above by default.
- `web-design-guidelines`: usability, accessibility, and responsive audits; use for review rather than as a competing design system.
- Existing `motion-design` and GSAP skills are secondary references. Use them only when the request specifically calls for broader motion direction or GSAP implementation.

## React technical reference

- `vercel-react-best-practices` is the technical reference for React implementation quality and performance. It supplements the selected UI/UX skill; it does not replace or redefine the visual responsibilities above.
- This project is a React 19, TypeScript, Vite client application. Apply framework-independent React guidance and preserve the existing TypeScript settings and Vite architecture. Skip Next.js-only guidance such as `next/dynamic`, Server Actions, React Server Component boundaries, `next/script`, and `next/server` APIs; translate applicable code-splitting ideas to Vite-native `import()` and existing React patterns. Check the installed React version before applying version-sensitive APIs.
- Recommendations that introduce SWR, `better-all`, or another package are optional. Do not add dependencies or replace existing data-fetching/caching libraries solely to follow a rule; prefer a native or already-installed option when it fits.
- Preserve the existing Supabase client, authentication, RLS, RPC, schema, and business rules. A React performance recommendation does not authorize changes to data contracts or security behavior.
