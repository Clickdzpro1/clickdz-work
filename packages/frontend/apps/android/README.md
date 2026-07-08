# Android

ClickDz Work Android app.

## Setup

- set CARGO_HOME to your system environment
- add

  `rust.cargoCommand={replace_with_your_own_cargo_home_absolute_path}/bin/cargo`

  `rust.rustcCommand={replace_with_your_own_cargo_home_absolute_path}/bin/rustc`

  to App/local.properties

## Build

- yarn install
- BUILD_TYPE=canary PUBLIC_PATH="/" yarn ClickDz Work @affine/android build
- yarn ClickDz Work @affine/android cap sync
- yarn ClickDz Work @affine/android cap open android
