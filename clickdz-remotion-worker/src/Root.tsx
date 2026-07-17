/**
 * clickdz-remotion-worker — the Remotion root.
 *
 * Registers ONE composition, `VdzVideo`, whose fps / dimensions /
 * durationInFrames are driven ENTIRELY by the manifest passed as input props
 * (via `calculateMetadata`). The server injects the manifest per render with
 * `inputProps`, so a single registered composition renders any timeline. The
 * static defaults below are only placeholders for the Remotion Studio preview.
 */

import React from 'react';
import { Composition } from 'remotion';

import type { RenderManifest } from './manifest';
import { VideoComposition } from './VideoComposition';

/** A minimal 1-frame placeholder manifest for the Studio default (real renders
 *  always override every field via inputProps + calculateMetadata). */
const PLACEHOLDER: RenderManifest = {
  version: 1,
  id: 'placeholder',
  name: 'placeholder',
  fps: 30,
  width: 1920,
  height: 1080,
  durationInFrames: 1,
  durationInSeconds: 0,
  tracks: [],
  unresolved: [],
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="VdzVideo"
      component={VideoComposition}
      durationInFrames={PLACEHOLDER.durationInFrames}
      fps={PLACEHOLDER.fps}
      width={PLACEHOLDER.width}
      height={PLACEHOLDER.height}
      defaultProps={{ manifest: PLACEHOLDER }}
      // Every dimension comes from the manifest at render time — the server sets
      // inputProps.manifest, and this pulls fps/size/duration off it so the
      // composition matches the timeline exactly.
      calculateMetadata={({ props }) => {
        const manifest = (props as { manifest?: RenderManifest }).manifest;
        if (!manifest) {
          return {
            durationInFrames: PLACEHOLDER.durationInFrames,
            fps: PLACEHOLDER.fps,
            width: PLACEHOLDER.width,
            height: PLACEHOLDER.height,
          };
        }
        return {
          durationInFrames: Math.max(1, Math.round(manifest.durationInFrames)),
          fps: manifest.fps,
          width: manifest.width,
          height: manifest.height,
        };
      }}
    />
  );
};
