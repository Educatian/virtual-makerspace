using System.Linq;
using Unity.Netcode;
using Unity.Netcode.Transports.UTP;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VirtualMakerspace.Sessions;
using VirtualMakerspace.Voice;

namespace VirtualMakerspace.Editor
{
    public static class CloudInfrastructureBuilder
    {
        private const string ScenePath = "Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity";

        [MenuItem("Virtual Makerspace/Configure Cloud Multiplayer")]
        public static void Configure()
        {
            var scene = EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
            GameObject systems = GameObject.Find("AppSystems") ?? new GameObject("AppSystems");

            NetworkManager manager = systems.GetComponent<NetworkManager>() ?? systems.AddComponent<NetworkManager>();
            UnityTransport transport = systems.GetComponent<UnityTransport>() ?? systems.AddComponent<UnityTransport>();
            manager.NetworkConfig.NetworkTransport = transport;

            VoiceChannelController voice = systems.GetComponent<VoiceChannelController>() ?? systems.AddComponent<VoiceChannelController>();
            MultiplayerSessionController sessions = systems.GetComponent<MultiplayerSessionController>() ?? systems.AddComponent<MultiplayerSessionController>();
            var serializedSessions = new SerializedObject(sessions);
            serializedSessions.FindProperty("voice").objectReferenceValue = voice;
            serializedSessions.ApplyModifiedPropertiesWithoutUndo();

            GameObject status = Resources.FindObjectsOfTypeAll<GameObject>()
                .FirstOrDefault(item => item.scene == scene && item.name == "CloudStatus")
                ?? new GameObject("CloudStatus");
            status.transform.position = new Vector3(0f, 1.35f, 0.95f);
            TextMesh statusText = status.GetComponent<TextMesh>();
            if (statusText == null)
            {
                statusText = status.AddComponent<TextMesh>();
            }
            statusText.text = "CLOUD READY: RELAY + VIVOX";
            statusText.fontSize = 64;
            statusText.characterSize = 0.018f;
            statusText.color = new Color(0.3f, 1f, 0.65f);
            statusText.anchor = TextAnchor.MiddleCenter;
            status.SetActive(false);

            EditorUtility.SetDirty(systems);
            EditorUtility.SetDirty(manager);
            EditorUtility.SetDirty(transport);
            EditorUtility.SetDirty(sessions);
            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene, ScenePath);
            AssetDatabase.SaveAssets();
            Debug.Log("CLOUD_INFRASTRUCTURE_READY NetworkManager UnityTransport Sessions Vivox");
        }
    }
}