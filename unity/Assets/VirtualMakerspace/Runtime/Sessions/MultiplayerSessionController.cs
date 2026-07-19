using System;
using System.Threading.Tasks;
using Unity.Services.Authentication;
using Unity.Services.Core;
using Unity.Services.Multiplayer;
using UnityEngine;
using VirtualMakerspace.Voice;

namespace VirtualMakerspace.Sessions
{
    public sealed class MultiplayerSessionController : MonoBehaviour
    {
        [SerializeField] private VoiceChannelController voice;

        public string RoomCode { get; private set; } = string.Empty;
        public bool IsConnected { get; private set; }

        public async Task<string> CreateRoomAsync()
        {
            await EnsureServicesAsync();
            var options = new SessionOptions
            {
                MaxPlayers = 2,
                Name = "Virtual Makerspace CPS",
                IsPrivate = true
            }.WithRelayNetwork();

            IHostSession session = await MultiplayerService.Instance.CreateSessionAsync(options);
            RoomCode = session.Code;
            IsConnected = true;
            await voice.ConnectAsync(RoomCode);
            return RoomCode;
        }

        public async Task JoinRoomAsync(string roomCode)
        {
            string normalizedCode = NormalizeRoomCode(roomCode);
            await EnsureServicesAsync();
            await MultiplayerService.Instance.JoinSessionByCodeAsync(normalizedCode);
            RoomCode = normalizedCode;
            IsConnected = true;
            await voice.ConnectAsync(RoomCode);
        }

        public static string NormalizeRoomCode(string roomCode)
        {
            if (string.IsNullOrWhiteSpace(roomCode))
            {
                throw new ArgumentException("A room code is required.", nameof(roomCode));
            }

            return roomCode.Trim().ToUpperInvariant();
        }

        private static async Task EnsureServicesAsync()
        {
            await UnityServices.InitializeAsync();
            if (!AuthenticationService.Instance.IsSignedIn)
            {
                await AuthenticationService.Instance.SignInAnonymouslyAsync();
            }
        }
    }
}