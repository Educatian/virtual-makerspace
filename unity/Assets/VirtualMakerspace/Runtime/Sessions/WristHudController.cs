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
        private bool attachedToWrist;
        private bool busy;

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
            ShowReadyState();
            TryAttachToWrist();
        }

        private void Update()
        {
            if (!attachedToWrist && XRSettings.isDeviceActive)
            {
                TryAttachToWrist();
            }
        }

        private void OnDestroy()
        {
            createButton.onClick.RemoveListener(CreateRoom);
            joinButton.onClick.RemoveListener(JoinRoom);
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
                ShowConnectedState(code, "1/2 CONNECTED", "WAITING FOR PARTNER");
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
                ShowConnectedState(session.RoomCode, "2/2 CONNECTED", "PARTNER READY");
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
            SetInteractable(true);
        }

        private void ShowConnectedState(string code, string participants, string guidance)
        {
            roomCodeText.text = "ROOM  " + code;
            connectionText.text = "ONLINE  |  SECURE RELAY";
            participantText.text = participants;
            voiceText.text = "VOICE  |  MIC ON";
            guidanceText.text = guidance;
            SetInteractable(true);
        }

        private void SetBusy(string message)
        {
            connectionText.text = message;
            guidanceText.text = "PLEASE WAIT";
            SetInteractable(false);
        }

        private void ShowError(Exception exception)
        {
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

        private void TryAttachToWrist()
        {
            if (!XRSettings.isDeviceActive || hudRoot == null) return;
            GameObject leftController = GameObject.Find("Left Controller");
            if (leftController == null) return;
            hudRoot.SetParent(leftController.transform, false);
            hudRoot.localPosition = new Vector3(0.06f, 0.10f, 0.14f);
            hudRoot.localRotation = Quaternion.Euler(68f, 0f, 0f);
            hudRoot.localScale = Vector3.one * 0.00072f;
            attachedToWrist = true;
        }
    }
}
