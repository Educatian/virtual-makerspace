using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.UI;
using UnityEngine.XR.Interaction.Toolkit.UI;
using VirtualMakerspace.Sessions;
using static VirtualMakerspace.Editor.HudUiFactory;

namespace VirtualMakerspace.Editor
{
    public static class WristHudBuilder
    {
        private const string ScenePath = "Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity";
        private static readonly Color Navy = new(0.018f, 0.035f, 0.065f, 0.96f);
        private static readonly Color Surface = new(0.055f, 0.09f, 0.14f, 0.98f);
        private static readonly Color Cyan = new(0.12f, 0.92f, 0.86f, 1f);
        private static readonly Color Muted = new(0.58f, 0.69f, 0.79f, 1f);

        [MenuItem("Virtual Makerspace/Build Wrist HUD")]
        public static void Build()
        {
            var scene = EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
            BuildIntoScene(GameObject.Find("DesktopPreviewCamera").GetComponent<Camera>());
            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.SaveAssets();
            Debug.Log("WRIST_HUD_READY create join room voice progress");
        }

        public static GameObject BuildIntoScene(Camera camera)
        {
            GameObject existing = GameObject.Find("Wrist HUD Canvas");
            if (existing != null) Object.DestroyImmediate(existing);
            HideLegacySigns();
            EnsureEventSystem();

            var go = new GameObject("Wrist HUD Canvas", typeof(RectTransform), typeof(Canvas),
                typeof(CanvasScaler), typeof(GraphicRaycaster));
            Canvas canvas = go.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvas.worldCamera = camera;
            canvas.sortingOrder = 20;
            RectTransform root = go.GetComponent<RectTransform>();
            root.sizeDelta = new Vector2(540f, 360f);
            root.SetParent(camera.transform, false);
            root.localPosition = new Vector3(-0.45f, -0.17f, 0.86f);
            root.localRotation = Quaternion.Euler(2f, 4f, 0f);
            root.localScale = Vector3.one * 0.00084f;
            go.GetComponent<CanvasScaler>().dynamicPixelsPerUnit = 2f;
            AddTrackedRaycaster(go);

            Image panel = Image(root, "HUD Panel", Navy, 0, 0, 540, 360);
            panel.gameObject.AddComponent<Shadow>().effectColor = new Color(0f, 0f, 0f, 0.65f);
            Image(root, "Cyan Rail", Cyan, 0, 0, 7, 360);
            Image(root, "Header", new Color(0.025f, 0.08f, 0.13f, 1f), 7, 312, 533, 48);
            Text(root, "Lab", "VM / BREADBOARD LAB", 21, FontStyle.Bold, Color.white, 24, 321, 320, 32);
            Text online = Text(root, "Online", "ONLINE", 16, FontStyle.Bold, Cyan, 420, 321, 95, 30);
            online.alignment = TextAnchor.MiddleRight;

            Text room = Text(root, "Room Code", "ROOM  MS42Q7", 30, FontStyle.Bold, Color.white, 24, 270, 492, 38);
            Image(root, "Relay Card", Surface, 24, 218, 238, 44);
            Text connection = Text(root, "Relay Status", "ONLINE  |  RELAY READY", 15, FontStyle.Bold, Cyan, 38, 226, 210, 28);
            Image(root, "Voice Card", Surface, 278, 218, 238, 44);
            Text voice = Text(root, "Voice Status", "VOICE  |  MIC ON", 15, FontStyle.Bold, Cyan, 292, 226, 210, 28);

            InputField input = Input(root, "Room Code Input", "MS42Q7", Surface, 24, 162, 238, 44);
            Button create = Button(root, "Create Room", "CREATE", 278, 162, 112, 44, new Color(0.03f, 0.43f, 0.62f, 1f));
            Button join = Button(root, "Join Room", "JOIN", 404, 162, 112, 44, new Color(0.08f, 0.55f, 0.43f, 1f));

            Text participants = Text(root, "Participants", "2/2 CONNECTED  |  DEMO USER A + B", 17,
                FontStyle.Bold, Color.white, 24, 122, 492, 28);
            Text(root, "Handoff", "HANDOFF: DEMO USER B", 14, FontStyle.Bold, Muted, 24, 96, 492, 24);
            Image(root, "Task Card", new Color(0.035f, 0.12f, 0.16f, 1f), 24, 46, 492, 42);
            Text guidance = Text(root, "Guidance", "STEP 02 / 05   PLACE THE RESISTOR", 16,
                FontStyle.Bold, Cyan, 38, 54, 464, 26);
            Image(root, "Progress Track", new Color(0.10f, 0.15f, 0.20f, 1f), 24, 24, 492, 8);
            Image(root, "Progress Fill", Cyan, 24, 24, 197, 8);
            Text(root, "Hint", "TRIGGER: SELECT  |  GRIP: MOVE  |  B: MENU", 12,
                FontStyle.Normal, Muted, 24, 2, 492, 18);

            MultiplayerSessionController session = Object.FindFirstObjectByType<MultiplayerSessionController>();
            WristHudController controller = go.AddComponent<WristHudController>();
            controller.Configure(session, root, input, create, join, room, connection, participants, voice, guidance);
            EditorUtility.SetDirty(controller);
            return go;
        }

        private static void HideLegacySigns()
        {
            string[] names = { "CloudStatus", "LobbyTitle", "RoomActions", "RoomCode", "MicState", "PartnerState" };
            foreach (string name in names)
            {
                GameObject found = GameObject.Find(name);
                if (found != null) found.SetActive(false);
            }
        }

        private static void EnsureEventSystem()
        {
            EventSystem eventSystem = Object.FindFirstObjectByType<EventSystem>(FindObjectsInactive.Include);
            if (eventSystem == null)
            {
                new GameObject("EventSystem", typeof(EventSystem), typeof(XRUIInputModule));
                return;
            }

            BaseInputModule[] inputModules = eventSystem.GetComponents<BaseInputModule>();
            foreach (BaseInputModule inputModule in inputModules)
            {
                if (inputModule is not XRUIInputModule)
                {
                    Object.DestroyImmediate(inputModule);
                }
            }

            if (eventSystem.GetComponent<XRUIInputModule>() == null)
                eventSystem.gameObject.AddComponent<XRUIInputModule>();
        }

        private static void AddTrackedRaycaster(GameObject target)
        {
            System.Type type = System.Type.GetType(
                "UnityEngine.XR.Interaction.Toolkit.UI.TrackedDeviceGraphicRaycaster, Unity.XR.Interaction.Toolkit");
            if (type != null) target.AddComponent(type);
        }
    }
}
