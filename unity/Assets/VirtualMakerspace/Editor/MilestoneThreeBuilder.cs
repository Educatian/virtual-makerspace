using System.Linq;
using Unity.Netcode;
using Unity.Netcode.Components;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.XR;
using UnityEngine.XR.Interaction.Toolkit;
using UnityEngine.XR.Interaction.Toolkit.Interactables;
using UnityEngine.XR.Interaction.Toolkit.Interactors;
using UnityEngine.XR.Interaction.Toolkit.Interactors.Visuals;
using UnityEngine.XR.Interaction.Toolkit.Inputs.Readers;
using Unity.XR.CoreUtils;
using VirtualMakerspace.Interaction;

namespace VirtualMakerspace.Editor
{
    public static class MilestoneThreeBuilder
    {
        public static void Build()
        {
            EditorSceneManager.OpenScene("Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity");
            EnsureInteractionManager();
            EnsureXrOrigin();
            ConfigureExistingControllers();
            ConfigurePreviewCamera();
            ConfigureNetworkPart(GameObject.Find("Resistor"));
            ConfigureNetworkPart(GameObject.Find("LED"));
            BuildSockets();
            RemoveMilestoneSignage();
            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            EditorSceneManager.SaveOpenScenes();
            AssetDatabase.SaveAssets();
            Debug.Log("Built Milestone 3 XR rig, sockets, and network handoff surface.");
        }

        private static void EnsureInteractionManager()
        {
            bool hasPersistentManager = Object.FindObjectsByType<XRInteractionManager>(FindObjectsInactive.Include, FindObjectsSortMode.None)
                .Any(candidate => candidate.gameObject.scene == EditorSceneManager.GetActiveScene() &&
                    (candidate.gameObject.hideFlags & HideFlags.DontSave) == 0);
            if (!hasPersistentManager)
            {
                new GameObject("XR Interaction Manager").AddComponent<XRInteractionManager>();
            }
        }

        private static void EnsureXrOrigin()
        {
            XROrigin existing = Object.FindObjectsByType<XROrigin>(FindObjectsInactive.Include, FindObjectsSortMode.None)
                .FirstOrDefault(candidate => candidate.gameObject.scene == EditorSceneManager.GetActiveScene() &&
                    (candidate.gameObject.hideFlags & HideFlags.DontSave) == 0);
            if (existing != null)
            {
                return;
            }

            var originObject = new GameObject("XR Origin");
            XROrigin origin = originObject.AddComponent<XROrigin>();
            var offset = new GameObject("Camera Offset");
            offset.transform.SetParent(originObject.transform, false);
            offset.transform.localPosition = new Vector3(0f, 1.36f, 0f);

            var cameraObject = new GameObject("XR Camera");
            cameraObject.transform.SetParent(offset.transform, false);
            Camera camera = cameraObject.AddComponent<Camera>();
            cameraObject.AddComponent<AudioListener>();
            TrackedPoseDriver cameraDriver = cameraObject.AddComponent<TrackedPoseDriver>();
            ConfigurePoseDriver(cameraDriver, "<XRHMD>/centerEyePosition", "<XRHMD>/centerEyeRotation");
            origin.Camera = camera;
            origin.CameraFloorOffsetObject = offset;

            CreateController(offset.transform, "Left Controller", true, new Color(0.18f, 0.55f, 1f));
            CreateController(offset.transform, "Right Controller", false, new Color(1f, 0.4f, 0.16f));
        }

        private static void CreateController(Transform parent, string name, bool leftHand, Color color)
        {
            GameObject controller = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            controller.name = name;
            controller.transform.SetParent(parent, false);
            controller.transform.localScale = Vector3.one * 0.12f;
            controller.GetComponent<Renderer>().sharedMaterial = CreateMaterial($"M_{name}", color);
            SphereCollider collider = controller.GetComponent<SphereCollider>();
            collider.isTrigger = true;
            Rigidbody body = controller.AddComponent<Rigidbody>();
            body.isKinematic = true;
            body.useGravity = false;
            TrackedPoseDriver driver = controller.AddComponent<TrackedPoseDriver>();
            string hand = leftHand ? "LeftHand" : "RightHand";
            ConfigurePoseDriver(driver, $"<XRController>{{{hand}}}/devicePosition", $"<XRController>{{{hand}}}/deviceRotation");
            ConfigureControllerInteraction(controller, leftHand);
        }

        private static void ConfigureExistingControllers()
        {
            ConfigureControllerInteraction(GameObject.Find("Left Controller"), true);
            ConfigureControllerInteraction(GameObject.Find("Right Controller"), false);
        }

        private static void ConfigureControllerInteraction(GameObject controller, bool leftHand)
        {
            string hand = leftHand ? "LeftHand" : "RightHand";
            XRDirectInteractor direct = controller.GetComponent<XRDirectInteractor>()
                ?? controller.AddComponent<XRDirectInteractor>();
            direct.selectInput = ButtonReader("Select", $"<XRController>{{{hand}}}/triggerPressed");
            direct.activateInput = ButtonReader("Activate", $"<XRController>{{{hand}}}/triggerPressed");

            Transform existingRay = controller.transform.Find("UI Ray");
            GameObject rayObject = existingRay != null ? existingRay.gameObject : new GameObject("UI Ray");
            if (existingRay == null)
            {
                rayObject.transform.SetParent(controller.transform, false);
            }

            XRRayInteractor ray = rayObject.GetComponent<XRRayInteractor>()
                ?? rayObject.AddComponent<XRRayInteractor>();
            ray.enableUIInteraction = true;
            ray.maxRaycastDistance = 5f;
            ray.selectInput = ButtonReader("Ray Select", $"<XRController>{{{hand}}}/triggerPressed");
            ray.activateInput = ButtonReader("Ray Activate", $"<XRController>{{{hand}}}/triggerPressed");
            ray.uiPressInput = ButtonReader("UI Press", $"<XRController>{{{hand}}}/triggerPressed");

            LineRenderer line = rayObject.GetComponent<LineRenderer>();
            if (line == null)
            {
                line = rayObject.AddComponent<LineRenderer>();
            }
            line.useWorldSpace = true;
            line.widthMultiplier = 0.006f;
            line.sharedMaterial = CreateMaterial($"M_{controller.name}_Ray", new Color(0.12f, 0.92f, 0.86f));

            XRInteractorLineVisual visual = rayObject.GetComponent<XRInteractorLineVisual>();
            if (visual == null)
            {
                visual = rayObject.AddComponent<XRInteractorLineVisual>();
            }
            visual.lineWidth = 0.006f;
            visual.lineLength = 5f;
        }

        private static XRInputButtonReader ButtonReader(string name, string binding)
        {
            var action = new InputAction(name, InputActionType.Button, binding);
            return new XRInputButtonReader(name, inputSourceMode: XRInputButtonReader.InputSourceMode.InputAction)
            {
                inputActionPerformed = action
            };
        }

        private static void ConfigurePoseDriver(TrackedPoseDriver driver, string positionBinding, string rotationBinding)
        {
            var position = new InputAction("Position", InputActionType.PassThrough, positionBinding);
            position.expectedControlType = "Vector3";
            var rotation = new InputAction("Rotation", InputActionType.PassThrough, rotationBinding);
            rotation.expectedControlType = "Quaternion";
            driver.positionInput = new InputActionProperty(position);
            driver.rotationInput = new InputActionProperty(rotation);
        }

        private static void ConfigurePreviewCamera()
        {
            GameObject preview = GameObject.Find("DesktopPreviewCamera");
            if (preview.GetComponent<DesktopPreviewCameraGate>() == null)
            {
                DesktopPreviewCameraGate gate = preview.AddComponent<DesktopPreviewCameraGate>();
                var serializedGate = new SerializedObject(gate);
                serializedGate.FindProperty("previewCamera").objectReferenceValue = preview.GetComponent<Camera>();
                serializedGate.ApplyModifiedPropertiesWithoutUndo();
            }
        }

        private static void ConfigureNetworkPart(GameObject part)
        {
            if (part == null)
            {
                throw new System.InvalidOperationException("Required breadboard part is missing from the release scene.");
            }

            EnsureInteractionCollider(part);
            Rigidbody body = part.GetComponent<Rigidbody>();
            if (body == null)
            {
                body = part.AddComponent<Rigidbody>();
            }
            body.useGravity = false;
            body.isKinematic = false;

            XRGrabInteractable grab = part.GetComponent<XRGrabInteractable>();
            if (grab == null)
            {
                grab = part.AddComponent<XRGrabInteractable>();
            }
            grab.movementType = XRBaseInteractable.MovementType.VelocityTracking;
            grab.throwOnDetach = false;

            if (part.GetComponent<NetworkObject>() == null)
            {
                part.AddComponent<NetworkObject>();
            }
            if (part.GetComponent<OwnerNetworkTransform>() == null)
            {
                part.AddComponent<OwnerNetworkTransform>();
            }
            if (part.GetComponent<NetworkBreadboardPart>() == null)
            {
                part.AddComponent<NetworkBreadboardPart>();
            }
        }

        private static void EnsureInteractionCollider(GameObject part)
        {
            Collider[] colliders = part.GetComponentsInChildren<Collider>(true);
            if (colliders.Length == 0)
            {
                BoxCollider collider = part.AddComponent<BoxCollider>();
                Renderer[] renderers = part.GetComponentsInChildren<Renderer>(true);
                if (renderers.Length > 0)
                {
                    Bounds localBounds = new Bounds(
                        part.transform.InverseTransformPoint(renderers[0].bounds.center),
                        Vector3.zero);
                    foreach (Renderer renderer in renderers)
                    {
                        Bounds worldBounds = renderer.bounds;
                        Vector3 min = part.transform.InverseTransformPoint(worldBounds.min);
                        Vector3 max = part.transform.InverseTransformPoint(worldBounds.max);
                        localBounds.Encapsulate(min);
                        localBounds.Encapsulate(max);
                    }

                    collider.center = localBounds.center;
                    collider.size = localBounds.size;
                }
            }

            foreach (Collider collider in part.GetComponentsInChildren<Collider>(true))
            {
                collider.isTrigger = false;
            }
        }

        private static void BuildSockets()
        {
            Vector3[] positions =
            {
                new Vector3(-0.45f, 0.91f, 0.23f),
                new Vector3(-0.15f, 0.91f, 0.23f),
                new Vector3(0.15f, 0.91f, 0.23f),
                new Vector3(0.45f, 0.91f, 0.23f),
                new Vector3(-0.45f, 0.91f, 0.48f),
                new Vector3(-0.15f, 0.91f, 0.48f),
                new Vector3(0.15f, 0.91f, 0.48f),
                new Vector3(0.45f, 0.91f, 0.48f)
            };

            for (int index = 0; index < positions.Length; index++)
            {
                string name = $"Breadboard Socket {index}";
                GameObject socketObject = GameObject.Find(name) ?? GameObject.CreatePrimitive(PrimitiveType.Sphere);
                socketObject.name = name;
                socketObject.transform.position = positions[index];
                socketObject.transform.localScale = Vector3.one * 0.055f;
                socketObject.GetComponent<Renderer>().sharedMaterial = CreateMaterial($"M_Socket_{index}", new Color(0.15f, 0.8f, 1f));
                Collider collider = socketObject.GetComponent<Collider>();
                collider.isTrigger = true;
                XRSocketInteractor socket = socketObject.GetComponent<XRSocketInteractor>() ?? socketObject.AddComponent<XRSocketInteractor>();
                socket.showInteractableHoverMeshes = false;
                socket.socketSnappingRadius = 0.09f;
                BreadboardSocket placement = socketObject.GetComponent<BreadboardSocket>() ?? socketObject.AddComponent<BreadboardSocket>();
                var serializedPlacement = new SerializedObject(placement);
                serializedPlacement.FindProperty("socketId").intValue = index;
                serializedPlacement.ApplyModifiedPropertiesWithoutUndo();
            }
        }

        private static void RemoveMilestoneSignage()
        {
            string[] names = { "XRStatus", "SocketStatus", "HandoffStatus" };
            foreach (string name in names)
            {
                GameObject existing = Object.FindObjectsByType<GameObject>(
                        FindObjectsInactive.Include, FindObjectsSortMode.None)
                    .FirstOrDefault(candidate => candidate.scene == EditorSceneManager.GetActiveScene() &&
                        candidate.name == name);
                if (existing != null)
                {
                    Object.DestroyImmediate(existing);
                }
            }
        }

        private static Material CreateMaterial(string name, Color color)
        {
            var material = new Material(Shader.Find("Standard"));
            material.name = name;
            material.color = color;
            return material;
        }
    }
}
