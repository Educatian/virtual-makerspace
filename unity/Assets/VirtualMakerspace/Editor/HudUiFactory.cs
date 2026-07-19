using UnityEngine;
using UnityEngine.UI;

namespace VirtualMakerspace.Editor
{
    internal static class HudUiFactory
    {
        public static Image Image(Transform parent, string name, Color color, float x, float y, float w, float h)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Image));
            go.transform.SetParent(parent, false);
            Image image = go.GetComponent<Image>();
            image.color = color;
            SetRect(image.rectTransform, x, y, w, h);
            return image;
        }

        public static Text Text(Transform parent, string name, string value, int size, FontStyle style,
            Color color, float x, float y, float w, float h)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(CanvasRenderer), typeof(Text));
            go.transform.SetParent(parent, false);
            Text text = go.GetComponent<Text>();
            text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            text.text = value;
            text.fontSize = size;
            text.fontStyle = style;
            text.color = color;
            text.alignment = TextAnchor.MiddleLeft;
            SetRect(text.rectTransform, x, y, w, h);
            return text;
        }

        public static Button Button(Transform parent, string name, string label, float x, float y,
            float w, float h, Color color)
        {
            Image image = Image(parent, name, color, x, y, w, h);
            Button button = image.gameObject.AddComponent<Button>();
            button.targetGraphic = image;
            ColorBlock colors = button.colors;
            colors.highlightedColor = Color.Lerp(color, Color.white, 0.18f);
            colors.pressedColor = Color.Lerp(color, Color.black, 0.22f);
            button.colors = colors;
            Text text = Text(image.transform, "Label", label, 16, FontStyle.Bold, Color.white, 0, 0, w, h);
            text.alignment = TextAnchor.MiddleCenter;
            return button;
        }

        public static InputField Input(Transform parent, string name, string value, Color color,
            float x, float y, float w, float h)
        {
            Image image = Image(parent, name, color, x, y, w, h);
            InputField input = image.gameObject.AddComponent<InputField>();
            Text text = Text(image.transform, "Text", value, 18, FontStyle.Bold, Color.white, 12, 0, w - 24, h);
            input.textComponent = text;
            input.text = value;
            input.characterLimit = 12;
            return input;
        }

        private static void SetRect(RectTransform rect, float x, float y, float w, float h)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.zero;
            rect.pivot = Vector2.zero;
            rect.anchoredPosition = new Vector2(x, y);
            rect.sizeDelta = new Vector2(w, h);
        }
    }
}
