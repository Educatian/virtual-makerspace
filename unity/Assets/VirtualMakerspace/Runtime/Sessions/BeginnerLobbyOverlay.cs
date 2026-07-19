using System;
using System.Threading.Tasks;
using UnityEngine;

namespace VirtualMakerspace.Sessions
{
    /// <summary>
    /// English-only learner lobby for creating or joining a two-person session.
    /// The overlay is created automatically so the current prototype can be tested
    /// without manually editing the scene.
    /// </summary>
    public sealed class BeginnerLobbyOverlay : MonoBehaviour
    {
        private MultiplayerSessionController session;
        private string roomCodeInput = string.Empty;
        private string roomCodeDisplay = "------";
        private string status = "Ready to connect";
        private string localUser = "Demo User A";
        private bool busy;
        private bool connected;
        private Rect windowRect = new Rect(32f, 32f, 520f, 560f);

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void Install()
        {
            if (FindFirstObjectByType<BeginnerLobbyOverlay>() != null ||
                FindFirstObjectByType<WristHudController>() != null)
            {
                return;
            }

            var root = new GameObject("English Beginner Lobby");
            DontDestroyOnLoad(root);
            root.AddComponent<BeginnerLobbyOverlay>();
        }

        private void Awake()
        {
            session = FindFirstObjectByType<MultiplayerSessionController>();
            if (session == null)
            {
                session = gameObject.AddComponent<MultiplayerSessionController>();
            }
        }

        private void OnGUI()
        {
            GUI.skin.label.wordWrap = true;
            GUI.skin.button.fontSize = 18;
            GUI.skin.textField.fontSize = 22;
            GUI.skin.label.fontSize = 17;
            GUI.skin.window.fontSize = 22;
            windowRect = GUI.Window(GetInstanceID(), windowRect, DrawWindow, "VIRTUAL MAKERSPACE LOBBY");
        }

        private void DrawWindow(int id)
        {
            GUILayout.Space(8);
            GUILayout.Label("Two-Person Breadboard Activity");
            GUILayout.Label("Create a private room or enter the code shared by your partner.");
            GUILayout.Space(12);

            GUILayout.BeginHorizontal();
            if (GUILayout.Button("CREATE ROOM", GUILayout.Height(52)))
            {
                _ = CreateRoomAsync();
            }
            if (GUILayout.Button("JOIN ROOM", GUILayout.Height(52)))
            {
                _ = JoinRoomAsync();
            }
            GUILayout.EndHorizontal();

            GUILayout.Space(12);
            GUILayout.Label("ROOM CODE");
            roomCodeInput = GUILayout.TextField(roomCodeInput.ToUpperInvariant(), 12, GUILayout.Height(44));
            GUILayout.Label("Share this code: " + roomCodeDisplay);

            GUILayout.Space(16);
            GUILayout.Label("CONNECTION STATUS");
            GUILayout.Label(busy ? "Connecting..." : status);

            GUILayout.Space(12);
            DrawParticipant(localUser, connected ? "Connected" : "Not connected", connected);
            DrawParticipant("Demo User B", connected ? "Waiting for partner" : "Not connected", false);

            GUILayout.Space(12);
            GUILayout.Label("VOICE");
            GUILayout.Label(connected ? "Vivox channel requested. Allow microphone access on Quest." : "Voice connects after room entry.");

            GUILayout.Space(16);
            GUILayout.Label("Success condition: both headsets show the same room code and 2/2 Connected.");
            GUI.enabled = !busy;
            if (GUILayout.Button("RESET LOBBY", GUILayout.Height(40)))
            {
                ResetLobby();
            }
            GUI.enabled = true;
            GUI.DragWindow(new Rect(0, 0, 10000, 36));
        }

        private static void DrawParticipant(string name, string state, bool active)
        {
            GUILayout.BeginHorizontal("box");
            GUILayout.Label(active ? "●" : "○", GUILayout.Width(28));
            GUILayout.Label(name, GUILayout.Width(190));
            GUILayout.Label(state);
            GUILayout.EndHorizontal();
        }

        private async Task CreateRoomAsync()
        {
            if (busy) return;
            busy = true;
            status = "Creating a secure Relay room...";
            localUser = "Demo User A";
            try
            {
                string code = await session.CreateRoomAsync();
                roomCodeDisplay = code;
                roomCodeInput = code;
                connected = true;
                status = "1/2 Connected - Waiting for Demo User B";
            }
            catch (Exception exception)
            {
                connected = false;
                status = "Connection failed: " + exception.GetBaseException().Message;
            }
            finally
            {
                busy = false;
            }
        }

        private async Task JoinRoomAsync()
        {
            if (busy) return;
            busy = true;
            status = "Joining the Relay room...";
            localUser = "Demo User B";
            try
            {
                await session.JoinRoomAsync(roomCodeInput);
                roomCodeDisplay = session.RoomCode;
                connected = true;
                status = "Connected - Verify that both headsets show 2/2 Connected";
            }
            catch (Exception exception)
            {
                connected = false;
                status = "Connection failed: " + exception.GetBaseException().Message;
            }
            finally
            {
                busy = false;
            }
        }

        private void ResetLobby()
        {
            roomCodeInput = string.Empty;
            roomCodeDisplay = "------";
            status = "Ready to connect";
            localUser = "Demo User A";
            connected = false;
            busy = false;
        }
    }
}

