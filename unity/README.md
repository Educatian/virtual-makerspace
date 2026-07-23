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

1. Request microphone permission on Quest Android and wait for the user's decision.
2. Initialize Unity Services.
3. Sign in anonymously.
4. Initialize and sign in to Vivox.
5. Join the `makerspace-{roomCode}` group audio channel.

Live Vivox communication requires a linked Unity Dashboard project with Vivox enabled. Voice recording and transcription must only be added after participant consent.

## Quest Release 1.0.7

- Learner-facing CREATE ROOM, JOIN ROOM, and room-code entry
- Automatic cleanup of a previous room before creating or joining another room
- Device-specific anonymous authentication profiles
- Live participant-count updates from the session service
- Relay connection and Vivox voice status reported separately
- World-placed session HUD that does not stay attached to a controller
- Trigger-selectable resistor and LED with solid XR colliders and breadboard sockets
- Immersive Quest launch category and microphone permission in the Android manifest
- Student installer revision 2 performs a clean install and launches the app through `com.oculus.intent.category.VR`, avoiding Quest's floating 2D application path
- The installer writes a filtered Unity/OpenXR device diagnostic file for any remaining headset-specific startup failure
- Completed 2/2 lobbies release the UGUI raycaster so controller rays reach the breadboard parts
- Backend membership conflicts trigger one cleanup-and-retry cycle
- Vivox connection waits for an explicit Quest microphone permission result
- Student acceptance collector captures immersive focus, 2/2 session, voice, and part-interaction evidence

Verification completed for this release:

- 29/29 Unity EditMode regression tests passed
- Unity Authentication, Relay allocation, Vivox login, and Vivox audio-channel smoke test passed
- Two independent anonymous cloud users created and joined the same private room; the guest observed two participants
- Two independent Windows player processes joined the same room and both verified Session 2/2, Relay/Netcode, and Vivox audio-channel state
- Android IL2CPP/ARM64 APK build passed for Quest 2 and Quest 3

## Reproducing the README Screenshots

Run `VirtualMakerspace.Editor.ActivityGuideCapture.Capture` in batch mode or from an editor command. It writes five 1280 × 720 Unity-rendered states to `Artifacts/UnityActivityGuide/`. The captures use a demo room code and do not claim a live two-headset session.

## Multiplayer and Voice

The learner-facing HUD provides CREATE ROOM, JOIN ROOM, room-code entry, Relay status, voice status, participant status, CPS handoff guidance, and task progress. Authentication, Relay session creation, and Vivox channel joining have passed live Unity service smoke verification.

## Quest Controls

- Trigger: select UI, grab breadboard parts, and release them into sockets
- A or X: advance the embedded beginner tutorial
- B or Y: return to the previous tutorial step

## Build and Install

1. Open this folder with Unity 6000.4.9f1.
2. Link your Unity Dashboard project and enable Authentication, Relay, and Vivox.
3. Generate local Vivox settings in the Unity Editor. The credential-bearing `ProjectSettings/Packages/com.unity.services.vivox/Settings.json` file is intentionally excluded from this public repository.
4. Run `VirtualMakerspace.Editor.QuestBuildPipeline.BuildQuestApk`.
5. Install the resulting ARM64 APK on a developer-mode Quest 2 or Quest 3.

## Security Boundary

Vivox Test Mode is suitable only for controlled pilots. Before a public production release, disable Test Mode and issue Vivox access tokens from a secure server. Never commit a Vivox token signing key.

