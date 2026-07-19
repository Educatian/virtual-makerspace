using System.Linq;
using NUnit.Framework;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.InputSystem.UI;
using UnityEngine.SceneManagement;
using UnityEngine.XR.Interaction.Toolkit.Interactors;
using UnityEngine.XR.Interaction.Toolkit.UI;

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
                Assert.That(ray, Is.Not.Null, controllerName);
                Assert.That(ray.enableUIInteraction, Is.True, controllerName);
                Assert.That(ray.uiPressInput.inputActionPerformed, Is.Not.Null, controllerName);
                Assert.That(ray.uiPressInput.inputActionPerformed.bindings.Count, Is.GreaterThan(0), controllerName);
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
