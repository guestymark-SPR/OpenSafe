These files are MediaPipe Tasks Vision 1.2.3 (npm package @mediapipe/tasks-vision),
copied unchanged: vision_bundle.mjs, vision_wasm_internal.js and vision_wasm_internal.wasm.
Copyright Google LLC. Licensed under the Apache License, Version 2.0 (LICENSE-Apache-2.0.txt).
https://github.com/google-ai-edge/mediapipe

OpenSafe Capture uses them for "Scan a room". The object detection model
(EfficientDet-Lite0, int8) is not stored here: the phone downloads it from Google once,
checks its SHA-256, and keeps it on the phone.

MediaPipe tries to send usage metrics to Google (odml.pa.googleapis.com). OpenSafe
Capture's Content-Security-Policy does not allow that address, so the browser blocks it.
