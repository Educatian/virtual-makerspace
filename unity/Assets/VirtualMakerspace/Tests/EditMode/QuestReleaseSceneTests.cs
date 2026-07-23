using System.Linq;
using NUnit.Framework;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem.UI;
using UnityEngine.SceneManagement;
using UnityEngine.UI;
using UnityEngine.XR.Interaction.Toolkit.Interactors;
using UnityEngine.XR.Interaction.Toolkit.Interactables;
using UnityEngine.XR.Interaction.Toolkit.UI;
using VirtualMakerspace.Sessions;

namespace VirtualMakerspace.Tests
{
    public sealed class QuestReleaseSceneTests
    {
        private const string ScenePath = "Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity";

        private Scene scene;

        [SetUp]
        public void SetUp()
        {
            scene = EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
        }

        [TearDown]
        public void TearDown()
        {
            EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        }

        [Test]
        public void MakerspaceScene_UsesXRUIInput_WhenLoaded()
        {
            // Given
            EventSystem eventSystem = Object.FindFirstObjectByType<EventSystem>();

            // When
            XRUIInputModule xrInput = eventSystem.GetComponent<XRUIInputModule>();

            // Then
            Assert.That(xrInput, Is.Not.Null);
            Assert.That(eventSystem.GetComponent<InputSystemUIInputModule>(), Is.Null);
        }

        [Test]
        public void MakerspaceScene_ControllersHaveBoundUiRays_WhenLoaded()
        {
            // Given
            string[] controllerNames = { "Left Controller", "Right Controller" };

            foreach (string controllerName in controllerNames)
            {
                // When
                GameObject controller = GameObject.Find(controllerName);
                XRDirectInteractor direct = controller.GetComponent<XRDirectInteractor>();
                XRRayInteractor ray = controller.GetComponentInChildren<XRRayInteractor>();

                // Then
                Assert.That(direct.selectInput.inputActionPerformed, Is.Not.Null, controllerName);
                Assert.That(direct.selectInput.inputActionPerformed.bindings.Count, Is.GreaterThan(0), controllerName);
                StringAssert.Contains("triggerPressed", direct.selectInput.inputActionPerformed.bindings[0].path,
                    controllerName + " direct-select must match the beginner trigger guidance.");
                Assert.That(ray, Is.Not.Null, controllerName);
                Assert.That(ray.enableUIInteraction, Is.True, controllerName);
                Assert.That(ray.uiPressInput.inputActionPerformed, Is.Not.Null, controllerName);
                Assert.That(ray.uiPressInput.inputActionPerformed.bindings.Count, Is.GreaterThan(0), controllerName);
            }
        }

        [Test]
        public void MakerspaceScene_BreadboardPartsAreActuallyGrabbable_WhenLoaded()
        {
            foreach (string partName in new[] { "Resistor", "LED" })
            {
                GameObject part = GameObject.Find(partName);
                Assert.That(part, Is.Not.Null, partName);
                Assert.That(part.GetComponent<XRGrabInteractable>(), Is.Not.Null, partName);
                Assert.That(part.GetComponent<Rigidbody>(), Is.Not.Null, partName);
                Collider[] colliders = part.GetComponentsInChildren<Collider>(true);
                Assert.That(colliders, Is.Not.Empty, partName + " has no hit target for XR interaction.");
                Assert.That(colliders.All(item => !item.isTrigger), Is.True,
                    partName + " grab colliders must be solid.");
            }
        }

        [Test]
        public void MakerspaceScene_HudIsNotParentedToAController_WhenLoaded()
        {
            GameObject hud = GameObject.Find("Wrist HUD Canvas");
            Assert.That(hud, Is.Not.Null);
            Assert.That(hud.transform.IsChildOf(GameObject.Find("Left Controller").transform), Is.False);
            Assert.That(hud.transform.IsChildOf(GameObject.Find("Right Controller").transform), Is.False);
        }

        [Test]
        public void MakerspaceScene_CompletedLobbyReleasesXrRayForActivityObjects()
        {
            WristHudController hud = Object.FindFirstObjectByType<WristHudController>();
            GraphicRaycaster raycaster = hud.GetComponentInParent<GraphicRaycaster>();

            hud.UnlockActivityInput();

            Assert.That(hud.ActivityUnlocked, Is.True);
            Assert.That(raycaster.enabled, Is.False,
                "The completed lobby must stop intercepting XR rays over the workbench.");
        }

        [Test]
        public void MakerspaceScene_ControllerRaysAndPartsShareAnInteractionLayer()
        {
            XRRayInteractor[] rays = Object.FindObjectsByType<XRRayInteractor>(FindObjectsSortMode.None);
            XRGrabInteractable[] parts = new[] { "Resistor", "LED" }
                .Select(name => GameObject.Find(name).GetComponent<XRGrabInteractable>())
                .ToArray();

            foreach (XRRayInteractor ray in rays)
            {
                foreach (XRGrabInteractable part in parts)
                {
                    int overlap = ray.interactionLayers.value & part.interactionLayers.value;
                    Assert.That(overlap, Is.Not.Zero,
                        $"{ray.name} cannot select {part.name} because their interaction layers do not overlap.");
                }
            }
        }

        [Test]
        public void MakerspaceScene_HasOneInactiveCloudStatus_WhenLoaded()
        {
            // Given / When
            GameObject[] statuses = Resources.FindObjectsOfTypeAll<GameObject>()
                .Where(item => item.scene == scene && item.name == "CloudStatus")
                .ToArray();

            // Then
            Assert.That(statuses, Has.Length.EqualTo(1));
            Assert.That(statuses[0].activeSelf, Is.False);
        }

        [Test]
        public void AndroidOpenXr_MetaQuestSupportIsEnabled_ForImmersiveQuestLaunch()
        {
            const string settingsPath = "Assets/XR/Settings/OpenXR Package Settings.asset";
            string serializedSettings = System.IO.File.ReadAllText(settingsPath);
            int featureStart = serializedSettings.IndexOf(
                "m_Name: MetaQuestFeature Android",
                System.StringComparison.Ordinal);
            Assert.That(featureStart, Is.GreaterThanOrEqualTo(0), "Meta Quest Android feature is missing.");

            int featureEnd = serializedSettings.IndexOf(
                "--- !u!",
                featureStart,
                System.StringComparison.Ordinal);
            string featureBlock = serializedSettings.Substring(featureStart, featureEnd - featureStart);
            StringAssert.Contains("m_enabled: 1", featureBlock,
                "Meta Quest Support must be enabled so Horizon OS launches the APK as immersive VR.");
        }

        [Test]
        public void MakerspaceScene_HasActiveCreateJoinRoomLobby_WhenLoaded()
        {
            var hud = Object.FindFirstObjectByType<VirtualMakerspace.Sessions.WristHudController>();

            Assert.That(hud, Is.Not.Null, "The immersive room lobby HUD is missing.");
            Assert.That(hud.gameObject.activeInHierarchy, Is.True, "The immersive room lobby HUD is inactive.");
            Assert.That(GameObject.Find("Room Code Input"), Is.Not.Null, "Room code input is missing.");
            GameObject createRoom = GameObject.Find("Create Room");
            GameObject joinRoom = GameObject.Find("Join Room");
            Assert.That(createRoom, Is.Not.Null, "CREATE ROOM control is missing.");
            Assert.That(joinRoom, Is.Not.Null, "JOIN ROOM control is missing.");
            Assert.That(createRoom.GetComponentInChildren<UnityEngine.UI.Text>().text, Is.EqualTo("CREATE ROOM"));
            Assert.That(joinRoom.GetComponentInChildren<UnityEngine.UI.Text>().text, Is.EqualTo("JOIN ROOM"));
        }

        [Test]
        public void MakerspaceScene_DoesNotContainDevelopmentStatusSigns_WhenLoaded()
        {
            string[] developmentSignNames = { "XRStatus", "SocketStatus", "HandoffStatus" };
            GameObject[] sceneObjects = Resources.FindObjectsOfTypeAll<GameObject>()
                .Where(item => item.scene == scene)
                .ToArray();

            foreach (string signName in developmentSignNames)
            {
                Assert.That(sceneObjects.Any(item => item.name == signName), Is.False, signName);
            }
        }
    }
}
