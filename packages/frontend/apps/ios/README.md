# iOS

ClickDz Work iOS app.

## Build

- `yarn install`
- `BUILD_TYPE=canary PUBLIC_PATH="/" yarn ClickDz Work @affine/ios build`
- `yarn ClickDz Work @affine/ios cap sync`
- `yarn ClickDz Work @affine/ios cap open ios`

## Live Reload

> Capacitor doc: https://capacitorjs.com/docs/guides/live-reload#using-with-framework-clis

- `yarn install`
- `yarn dev`
  - select `ios` for the "Distribution" option
- `yarn ClickDz Work @affine/ios sync:dev`
- `yarn ClickDz Work @affine/ios cap open ios`
