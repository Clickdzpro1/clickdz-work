/**
 * clickdz-remotion-worker — Remotion entry point.
 *
 * `registerRoot` is what @remotion/bundler bundles; the server points the
 * bundler at THIS file. Kept side-effect-only (no server import) so bundling the
 * composition never drags in Express.
 */
import { registerRoot } from 'remotion';

import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);
