using System.IO;
using System.Linq;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;

namespace VirtualMakerspace.Editor
{
    public static class ActivityGuideCapture
    {
        private static readonly string[] Files =
        {
            "01-launch-and-open-menu.png", "02-create-and-share-code.png",
            "03-join-and-check-voice.png", "04-place-resistor-and-handoff.png",
            "05-place-led-and-explain.png"
        };

        private static readonly string[,] Copy =
        {
            { "ROOM  ------", "READY  |  SELECT CREATE OR JOIN", "VOICE  |  WAITING", "0/2 CONNECTED", "ROLE: CHOOSE HOST OR PARTNER", "STEP 01 / 05   OPEN THE ROOM MENU" },
            { "ROOM  MS42Q7", "ONLINE  |  RELAY HOSTING", "VOICE  |  CONNECTING", "1/2 CONNECTED  |  USER A", "USER A: SHARE MS42Q7", "STEP 02 / 05   CREATE + SHARE ROOM CODE" },
            { "ROOM  MS42Q7", "ONLINE  |  RELAY READY", "VOICE  |  MIC ON", "2/2 CONNECTED  |  USER A + USER B", "SAY: I CAN HEAR YOU", "STEP 03 / 05   JOIN + CONFIRM PARTNER VOICE" },
            { "ROOM  MS42Q7", "ONLINE  |  RELAY READY", "VOICE  |  MIC ON", "2/2 CONNECTED  |  USER A + USER B", "HANDOFF: USER A > USER B", "STEP 04 / 05   USER A: PLACE THE RESISTOR" },
            { "ROOM  MS42Q7", "ONLINE  |  RELAY READY", "VOICE  |  MIC ON", "2/2 CONNECTED  |  USER A + USER B", "CPS CHECK: EXPLAIN + VERIFY", "STEP 05 / 05   USER B: PLACE LED + EXPLAIN" }
        };

        private static readonly string[] Fields =
            { "Room Code", "Relay Status", "Voice Status", "Participants", "Handoff", "Guidance" };

        public static void Capture()
        {
            EditorSceneManager.OpenScene("Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity");
            Camera camera = GameObject.Find("DesktopPreviewCamera").GetComponent<Camera>();
            GameObject hud = GameObject.Find("Wrist HUD Canvas");
            Text[] texts = hud.GetComponentsInChildren<Text>(true);
            string[] originals = texts.Select(item => item.text).ToArray();
            RectTransform progress = Find(hud, "Progress Fill").GetComponent<RectTransform>();
            Vector2 originalSize = progress.sizeDelta;
            Directory.CreateDirectory("Artifacts/UnityActivityGuide");

            for (int step = 0; step < Files.Length; step++)
            {
                for (int field = 0; field < Fields.Length; field++)
                    Find(hud, Fields[field]).GetComponent<Text>().text = Copy[step, field];
                progress.sizeDelta = new Vector2(492f * (step + 1) / Files.Length, originalSize.y);
                Canvas.ForceUpdateCanvases();
                CaptureFrame(camera, Path.Combine("Artifacts/UnityActivityGuide", Files[step]));
            }

            for (int index = 0; index < texts.Length; index++)
                texts[index].text = originals[index];
            progress.sizeDelta = originalSize;
            Debug.Log($"ACTIVITY_GUIDE_CAPTURE_READY count={Files.Length}");
        }

        private static GameObject Find(GameObject root, string objectName)
        {
            Transform match = root.GetComponentsInChildren<Transform>(true)
                .FirstOrDefault(item => item.name == objectName);
            if (match == null)
                throw new MissingReferenceException($"HUD object not found: {objectName}");
            return match.gameObject;
        }

        private static void CaptureFrame(Camera camera, string path)
        {
            var target = new RenderTexture(1280, 720, 24);
            var texture = new Texture2D(1280, 720, TextureFormat.RGB24, false);
            camera.targetTexture = target;
            camera.Render();
            RenderTexture.active = target;
            texture.ReadPixels(new Rect(0, 0, 1280, 720), 0, 0);
            texture.Apply();
            File.WriteAllBytes(path, texture.EncodeToPNG());
            camera.targetTexture = null;
            RenderTexture.active = null;
            Object.DestroyImmediate(texture);
            target.Release();
            Object.DestroyImmediate(target);
        }
    }
}
