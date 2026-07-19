using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace VirtualMakerspace.Editor
{
    public static class MakerspacePreviewCapture
    {
        public static void Capture()
        {
            EditorSceneManager.OpenScene("Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity");
            Camera camera = GameObject.Find("DesktopPreviewCamera").GetComponent<Camera>();
            var target = new RenderTexture(1280, 720, 24);
            var texture = new Texture2D(1280, 720, TextureFormat.RGB24, false);
            target.Create();

            if (GraphicsSettings.currentRenderPipeline != null)
            {
                var request = new RenderPipeline.StandardRequest { destination = target };
                if (!RenderPipeline.SupportsRenderRequest(camera, request))
                {
                    throw new System.InvalidOperationException(
                        "The active render pipeline does not support camera render requests.");
                }
                RenderPipeline.SubmitRenderRequest(camera, request);
            }
            else
            {
                camera.targetTexture = target;
                camera.Render();
                camera.targetTexture = null;
            }

            RenderTexture.active = target;
            texture.ReadPixels(new Rect(0, 0, 1280, 720), 0, 0);
            texture.Apply();

            Color32 first = texture.GetPixel(0, 0);
            bool hasVisibleContent = false;
            for (int y = 0; y < texture.height && !hasVisibleContent; y += 24)
            {
                for (int x = 0; x < texture.width; x += 24)
                {
                    Color32 sample = texture.GetPixel(x, y);
                    if (System.Math.Abs(sample.r - first.r) > 2 ||
                        System.Math.Abs(sample.g - first.g) > 2 ||
                        System.Math.Abs(sample.b - first.b) > 2)
                    {
                        hasVisibleContent = true;
                        break;
                    }
                }
            }

            if (!hasVisibleContent)
            {
                throw new System.InvalidOperationException(
                    "Capture produced a blank or single-color frame; screenshot was not written.");
            }

            File.WriteAllBytes("Artifacts/MakerspacePrototype.png", texture.EncodeToPNG());
            RenderTexture.active = null;
            Object.DestroyImmediate(texture);
            target.Release();
            Object.DestroyImmediate(target);
            Debug.Log("Captured Artifacts/MakerspacePrototype.png");
        }
    }
}