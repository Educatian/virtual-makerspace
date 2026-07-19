using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace VirtualMakerspace.Editor
{
    internal static class PbrMaterialLibrary
    {
        private const string MaterialRoot = "Assets/VirtualMakerspace/Art/Materials";
        private const string TextureRoot = "Assets/VirtualMakerspace/Art/PBRTextures";

        private readonly struct Spec
        {
            public Spec(string name, string texture, float metallic, float smoothness, Color emission)
            {
                Name = name;
                Texture = texture;
                Metallic = metallic;
                Smoothness = smoothness;
                Emission = emission;
            }

            public string Name { get; }
            public string Texture { get; }
            public float Metallic { get; }
            public float Smoothness { get; }
            public Color Emission { get; }
        }

        public static Dictionary<string, Material> Build()
        {
            EnsureFolder();
            Spec[] specs =
            {
                new("M_Dark_Walnut", "Walnut", 0f, 0.30f, Color.black),
                new("M_Graphite", "Graphite", 0.22f, 0.42f, Color.black),
                new("M_Black_Rubber", "BlackRubber", 0f, 0.16f, Color.black),
                new("M_Brushed_Metal", "BrushedMetal", 0.86f, 0.58f, Color.black),
                new("M_Plastic_White", "WhitePlastic", 0f, 0.48f, Color.black),
                new("M_Red", "RedPlastic", 0f, 0.52f, Color.black),
                new("M_Blue", "BluePlastic", 0f, 0.52f, Color.black),
                new("M_Green", "GreenPlastic", 0f, 0.52f, Color.black),
                new("M_Yellow", "YellowPlastic", 0f, 0.52f, Color.black),
                new("M_Cyan_Emission", null, 0f, 0.82f, new Color(0.05f, 1.8f, 3.2f)),
                new("M_Amber_Emission", null, 0f, 0.82f, new Color(3.2f, 0.9f, 0.04f)),
                new("M_LED_Red", null, 0f, 0.82f, new Color(3.5f, 0.03f, 0.01f))
            };

            var result = new Dictionary<string, Material>(StringComparer.OrdinalIgnoreCase);
            foreach (Spec spec in specs)
            {
                result.Add(spec.Name, Create(spec));
            }
            AssetDatabase.SaveAssets();
            return result;
        }

        public static void Apply(Transform root, Dictionary<string, Material> materials)
        {
            foreach (Renderer renderer in root.GetComponentsInChildren<Renderer>(true))
            {
                Material[] assigned = renderer.sharedMaterials;
                for (int index = 0; index < assigned.Length; index++)
                {
                    string sourceName = assigned[index] == null ? string.Empty : assigned[index].name;
                    if (materials.TryGetValue(sourceName, out Material replacement))
                    {
                        assigned[index] = replacement;
                    }
                }
                renderer.sharedMaterials = assigned;
            }
        }

        private static Material Create(Spec spec)
        {
            string path = $"{MaterialRoot}/PBR_{spec.Name}.mat";
            Material material = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (material == null)
            {
                material = new Material(Shader.Find("Standard"));
                AssetDatabase.CreateAsset(material, path);
            }
            material.shader = Shader.Find("Standard");
            material.SetFloat("_Metallic", spec.Metallic);
            material.SetFloat("_Glossiness", spec.Smoothness);
            if (spec.Texture != null)
            {
                string normalPath = $"{TextureRoot}/{spec.Texture}_Normal.png";
                ConfigureNormalTexture(normalPath);
                material.SetColor("_Color", Color.white);
                material.SetTexture("_MainTex", AssetDatabase.LoadAssetAtPath<Texture2D>($"{TextureRoot}/{spec.Texture}_Albedo.png"));
                material.SetTexture("_BumpMap", AssetDatabase.LoadAssetAtPath<Texture2D>(normalPath));
                material.SetFloat("_BumpScale", 0.22f);
                material.EnableKeyword("_NORMALMAP");
                material.DisableKeyword("_EMISSION");
            }
            else
            {
                material.SetColor("_Color", spec.Emission / 3f);
                material.SetColor("_EmissionColor", spec.Emission);
                material.EnableKeyword("_EMISSION");
                material.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            }
            EditorUtility.SetDirty(material);
            return material;
        }

        private static void ConfigureNormalTexture(string path)
        {
            if (AssetImporter.GetAtPath(path) is TextureImporter importer && importer.textureType != TextureImporterType.NormalMap)
            {
                importer.textureType = TextureImporterType.NormalMap;
                importer.sRGBTexture = false;
                importer.mipmapEnabled = true;
                importer.SaveAndReimport();
            }
        }

        private static void EnsureFolder()
        {
            if (!AssetDatabase.IsValidFolder(MaterialRoot))
            {
                AssetDatabase.CreateFolder("Assets/VirtualMakerspace/Art", "Materials");
            }
        }
    }
}
