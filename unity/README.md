# Virtual Makerspace Unity

A two-person immersive virtual reality breadboard prototype for collaborative problem solving (CPS) on Meta Quest 2 and Quest 3.

## Current Scope

- Standalone Unity 6000.4.9f1 project
- OpenXR, Meta OpenXR, and XR Interaction Toolkit
- Netcode for GameObjects 2.x with Multiplayer Services and Relay
- Vivox group voice-channel connector
- Pure C# breadboard circuit evaluation with EditMode tests
- Desktop-previewable breadboard prototype scene builder
- Embedded beginner tutorial video asset
- One-command Quest build and installation workflow

## Build the Prototype Scene

In Unity, select `Virtual Makerspace > Build Prototype Scene`, or run:

`VirtualMakerspace.Editor.MakerspacePrototypeBuilder.Build`

## Voice Connection Flow

1. Initialize Unity Services.
2. Sign in anonymously.
3. Initialize and sign in to Vivox.
4. Join the `makerspace-{roomCode}` group audio channel.
5. Request microphone permission on Quest Android.

Live Vivox communication requires a linked Unity Dashboard project with Vivox enabled. Voice recording and transcription must only be added after participant consent.

## Reproducing the README Screenshots

Run `VirtualMakerspace.Editor.ActivityGuideCapture.Capture` in batch mode or from an editor command. It writes five 1280 × 720 Unity-rendered states to `Artifacts/UnityActivityGuide/`. The captures use a demo room code and do not claim a live two-headset session.

## Multiplayer and Voice

The learner-facing HUD provides CREATE ROOM, JOIN ROOM, room-code entry, Relay status, voice status, participant status, CPS handoff guidance, and task progress. Authentication, Relay session creation, and Vivox channel joining have passed live Unity service smoke verification.

## Quest Controls

- Trigger: select UI and activate interactables
- Grip: direct grab and move breadboard parts
- A or X: advance the embedded beginner tutorial
- B or Y: return to the previous tutorial step

## Build and Install

1. Open this folder with Unity 6000.4.9f1.
2. Link your own Unity Dashboard project and enable Authentication, Relay, and Vivox.
3. Generate local Vivox settings in the Unity Editor. The credential-bearing `ProjectSettings/Packages/com.unity.services.vivox/Settings.json` file is intentionally excluded from this public repository.
4. Run `VirtualMakerspace.Editor.QuestBuildPipeline.BuildQuestApk`.
5. Install the resulting ARM64 APK on a developer-mode Quest 2 or Quest 3.

## Validation

- 16 EditMode tests pass.
- Quest XR UI uses `XRUIInputModule` with controller UI rays.
- The release scene contains no milestone/debug status signage.
- A live service smoke test verified anonymous authentication, Relay session creation, Vivox login, and Vivox channel join.

## Security Boundary

Vivox Test Mode is suitable only for controlled pilots. Before a public production release, disable Test Mode and issue Vivox access tokens from a secure server. Never commit a Vivox token signing key.
