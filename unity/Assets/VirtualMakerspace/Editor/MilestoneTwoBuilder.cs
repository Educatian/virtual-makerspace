using Unity.Netcode;
using Unity.Netcode.Transports.UTP;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VirtualMakerspace.Sessions;
using VirtualMakerspace.Voice;

namespace VirtualMakerspace.Editor
{
    public static class MilestoneTwoBuilder
    {
        public static void Build()
        {
            EditorSceneManager.OpenScene("Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity");
            GameObject systems = GameObject.Find("AppSystems");
            VoiceChannelController voice = systems.GetComponent<VoiceChannelController>();
            MultiplayerSessionController session = systems.GetComponent<MultiplayerSessionController>();
            if (session == null)
            {
                session = systems.AddComponent<MultiplayerSessionController>();
            }

            var serializedSession = new SerializedObject(session);
            serializedSession.FindProperty("voice").objectReferenceValue = voice;
            serializedSession.ApplyModifiedPropertiesWithoutUndo();

            GameObject networkObject = GameObject.Find("NetworkManager");
            if (networkObject == null)
            {
                networkObject = new GameObject("NetworkManager");
                NetworkManager manager = networkObject.AddComponent<NetworkManager>();
                UnityTransport transport = networkObject.AddComponent<UnityTransport>();
                manager.NetworkConfig.NetworkTransport = transport;
            }

            CreateSign("LobbyTitle", "VIRTUAL MAKERSPACE", new Vector3(-1.05f, 1.72f, 0.95f), 0.11f, Color.white);
            CreateSign("RoomActions", "CREATE ROOM     JOIN ROOM", new Vector3(-1.05f, 1.52f, 0.95f), 0.075f, new Color(0.35f, 0.85f, 1f));
            CreateSign("RoomCode", "ROOM CODE: ------", new Vector3(-1.05f, 1.34f, 0.95f), 0.07f, new Color(1f, 0.8f, 0.2f));
            CreateSign("MicState", "MICROPHONE: READY", new Vector3(-1.05f, 1.17f, 0.95f), 0.06f, new Color(0.35f, 1f, 0.45f));
            CreateSign("PartnerState", "PARTNER: WAITING", new Vector3(-1.05f, 1.02f, 0.95f), 0.06f, new Color(0.75f, 0.75f, 0.8f));

            EditorSceneManager.SaveOpenScenes();
            AssetDatabase.SaveAssets();
            Debug.Log("Built Milestone 2 lobby and network session surface.");
        }

        private static void CreateSign(string name, string content, Vector3 position, float size, Color color)
        {
            GameObject existing = GameObject.Find(name);
            if (existing != null)
            {
                Object.DestroyImmediate(existing);
            }

            var sign = new GameObject(name);
            sign.transform.position = position;
            sign.transform.rotation = Quaternion.Euler(0f, 0f, 0f);
            TextMesh text = sign.AddComponent<TextMesh>();
            text.text = content;
            text.fontSize = 64;
            text.characterSize = size;
            text.color = color;
            text.anchor = TextAnchor.MiddleLeft;
        }
    }
}