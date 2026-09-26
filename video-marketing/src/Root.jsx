import React from 'react';
import {Composition} from 'remotion';
import {MimVideo} from './MimVideo.jsx';

const durationInFrames = 1800;
const fps = 30;

export const Root = () => (
  <>
    <Composition
      id="MimVideoLandscape"
      component={MimVideo}
      durationInFrames={durationInFrames}
      fps={fps}
      width={1920}
      height={1080}
      defaultProps={{vertical: false}}
    />
    <Composition
      id="MimVideoPortrait"
      component={MimVideo}
      durationInFrames={durationInFrames}
      fps={fps}
      width={1080}
      height={1920}
      defaultProps={{vertical: true}}
    />
  </>
);
