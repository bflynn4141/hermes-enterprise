# Hermes motion components

Reusable React components and an interactive workshop adapted from [Beautiful UI](https://www.beautifului.dev/), with Hermes Enterprise typography, navy gradients and glass assets.

## Run

```sh
pnpm install
pnpm build
pnpm dev
```

Open http://127.0.0.1:4176. Choose a component, replay its sequence, try its variants, or enable Reduce motion. Each specimen also has a Usage tab. The existing Hermes demos and Paper pages are unchanged.

## Reuse

The package exports 21 primitives, a motion provider and shared atoms. `src/index.ts` is the source entry; `dist/index.js` and `dist/components.css` are the compiled deliverables. Import both the component and stylesheet. Keep the provider around components, or apply the `.hermes-ui` class plus OS motion handling in an existing integration.

```tsx
import { HermesMotionProvider, LoadingState, AgentScreen } from './dist/index.js';
import './dist/components.css';

<HermesMotionProvider>
  <LoadingState label="Reading partner criteria" variant="Orbit" />
  <AgentScreen agentName="Iris" streamSrc={workspacePreviewUrl} />
</HermesMotionProvider>
```

For a local package dependency, use the package name `@hermes/motion-components`; consumers must supply React and install the declared dependencies. Fonts in the gallery load from Google Fonts. Host applications should provide Inter and Barlow Condensed or compatible fallbacks. Internal imports are relative; the package entry points to the compiled module and requires no application-specific alias.

Fixtures and showcase controls are in `demo/`; reusable implementations are in `src/components/`. Components expose typed props and callbacks in their source. Applications must connect these to real tools, persistence, model selection, authority checks and execution results. Default examples and capture/dictation are local simulations; this is not a backend or a production approval system.

Read [REFERENCE.md](docs/REFERENCE.md) for fidelity decisions and [QA.md](docs/QA.md) for verified behavior. Preserve [LICENSE.beautiful-ui](LICENSE.beautiful-ui) when redistributing adapted source. Original source: copyright 2026 Shane Levine, MIT.
