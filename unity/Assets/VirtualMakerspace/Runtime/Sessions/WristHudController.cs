using System;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.XR;

namespace VirtualMakerspace.Sessions
{
    public sealed class WristHudController : MonoBehaviour
    {
        [SerializeField] private MultiplayerSessionController session;
        [SerializeField] private RectTransform hudRoot;
        [SerializeField] private InputField roomCodeInput;
        [SerializeField] private Button createButton;
        [SerializeField] private Button joinButton;
        [SerializeField] private Text roomCodeText;
        [SerializeField] private Text connectionText;
        [SerializeField] private Text participantText;
        [SerializeField] private Text voiceText;
        [SerializeField] private Text guidanceText;
        private GraphicRaycaster lobbyRaycaster;
        private bool placedInWorld;
        private bool busy;

        public bool ActivityUnlocked { get; private set; }

        public void Configure(MultiplayerSessionController sessionController, RectTransform root,
            InputField input, Button create, Button join, Text roomCode, Text connection,
            Text participants, Text voice, Text guidance)
        {
            session = sessionController;
            hudRoot = root;
            roomCodeInput = input;
            createButton = create;
            joinButton = join;
            roomCodeText = roomCode;
            connectionText = connection;
            participantText = participants;
            voiceText = voice;
            guidanceText = guidance;
        }

        private void Awake()
        {
            session ??= FindFirstObjectByType<MultiplayerSessionController>();
            createButton.onClick.AddListener(CreateRoom);
            joinButton.onClick.AddListener(JoinRoom);
        }

        private void Start()
        {
            lobbyRaycaster = hudRoot != null ? hudRoot.GetComponentInParent<GraphicRaycaster>() : null;
            ShowReadyState();
            TryPlaceInWorld();
            session.ParticipantCountChanged += HandleParticipantCountChanged;
        }

        private void Update()
        {
            if (!placedInWorld && XRSettings.isDeviceActive)
            {
                TryPlaceInWorld();
            }
        }

        private void OnDestroy()
        {
            createButton.onClick.RemoveListener(CreateRoom);
            joinButton.onClick.RemoveListener(JoinRoom);
            if (session != null)
            {
                session.ParticipantCountChanged -= HandleParticipantCountChanged;
            }
        }

        public void CreateRoom()
        {
            if (!busy) _ = CreateRoomAsync();
        }

        public void JoinRoom()
        {
            if (!busy) _ = JoinRoomAsync();
        }

        private async Task CreateRoomAsync()
        {
            SetBusy("CREATING SECURE ROOM...");
            try
            {
                string code = await session.CreateRoomAsync();
                roomCodeInput.text = code;
                ShowConnectedState(code, "WAITING FOR PARTNER");
            }
            catch (Exception exception)
            {
                ShowError(exception);
            }
        }

        private async Task JoinRoomAsync()
        {
            SetBusy("JOINING ROOM...");
            try
            {
                await session.JoinRoomAsync(roomCodeInput.text);
                ShowConnectedState(session.RoomCode, "PARTNER READY");
            }
            catch (Exception exception)
            {
                ShowError(exception);
            }
        }

        private void ShowReadyState()
        {
            roomCodeText.text = "ROOM  ------";
            connectionText.text = "ONLINE  |  RELAY READY";
            participantText.text = "0/2 CONNECTED";
            voiceText.text = "VOICE  |  CONNECTS WITH ROOM";
            guidanceText.text = "CREATE A ROOM OR ENTER YOUR PARTNER'S CODE";
            RestoreLobbyInput();
            SetInteractable(true);
        }

        private void ShowConnectedState(string code, string guidance)
        {
            roomCodeText.text = "ROOM  " + code;
            connectionText.text = "ONLINE  |  SECURE RELAY";
            participantText.text = $"{Mathf.Clamp(session.ParticipantCount, 1, 2)}/2 CONNECTED";
            voiceText.text = session.IsVoiceConnected ? "VOICE  |  MIC ON" : "VOICE  |  UNAVAILABLE";
            guidanceText.text = string.IsNullOrWhiteSpace(session.VoiceWarning)
                ? guidance
                : "ROOM CONNECTED; CHECK VOICE SERVICE";
            SetInteractable(true);
            if (session.ParticipantCount >= 2)
            {
                UnlockActivityInput();
            }
        }

        private void SetBusy(string message)
        {
            connectionText.text = message;
            guidanceText.text = "PLEASE WAIT";
            SetInteractable(false);
        }

        private void ShowError(Exception exception)
        {
            RestoreLobbyInput();
            connectionText.text = "CONNECTION FAILED";
            guidanceText.text = exception.GetBaseException().Message.ToUpperInvariant();
            SetInteractable(true);
        }

        private void SetInteractable(bool value)
        {
            busy = !value;
            createButton.interactable = value;
            joinButton.interactable = value;
        }

        private void HandleParticipantCountChanged(int count)
        {
            if (!session.IsConnected)
            {
                return;
            }

            int displayedCount = Mathf.Clamp(count, 1, 2);
            participantText.text = $"{displayedCount}/2 CONNECTED";
            if (displayedCount >= 2)
            {
                UnlockActivityInput();
            }
            else
            {
                RestoreLobbyInput();
                guidanceText.text = "WAITING FOR PARTNER";
            }
        }

        /// <summary>
        /// Stops the completed lobby from intercepting XR rays so both learners can
        /// immediately grab and place breadboard parts. The status HUD remains visible.
        /// </summary>
        public void UnlockActivityInput()
        {
            bool wasUnlocked = ActivityUnlocked;
            lobbyRaycaster ??= hudRoot != null ? hudRoot.GetComponentInParent<GraphicRaycaster>() : null;
            ActivityUnlocked = true;
            busy = false;
            createButton.interactable = false;
            joinButton.interactable = false;
            roomCodeInput.interactable = false;
            guidanceText.text = "ACTIVITY UNLOCKED  |  USE TRIGGER TO GRAB PARTS";
            if (lobbyRaycaster != null)
            {
                lobbyRaycaster.enabled = false;
            }

            if (!wasUnlocked)
            {
                Debug.Log($"VM_ACCEPTANCE ACTIVITY_UNLOCKED room={session.RoomCode} participants={session.ParticipantCount} voice={session.IsVoiceConnected}");
            }
        }

        private void RestoreLobbyInput()
        {
            ActivityUnlocked = false;
            if (roomCodeInput != null)
            {
                roomCodeInput.interactable = true;
            }

            if (lobbyRaycaster != null)
            {
                lobbyRaycaster.enabled = true;
            }
        }

        private void TryPlaceInWorld()
        {
            if (!XRSettings.isDeviceActive || hudRoot == null) return;
            GameObject xrCamera = GameObject.Find("XR Camera");
            if (xrCamera == null) return;
            Transform cameraTransform = xrCamera.transform;
            hudRoot.SetParent(null, true);
            hudRoot.position = cameraTransform.TransformPoint(new Vector3(-0.42f, -0.10f, 0.92f));
            hudRoot.rotation = cameraTransform.rotation * Quaternion.Euler(2f, 4f, 0f);
            hudRoot.localScale = Vector3.one * 0.00084f;
            placedInWorld = true;
        }
    }
}
