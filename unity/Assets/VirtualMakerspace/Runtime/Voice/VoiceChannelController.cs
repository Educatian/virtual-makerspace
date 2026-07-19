using System;
using System.Threading.Tasks;
using Unity.Services.Authentication;
using Unity.Services.Core;
using Unity.Services.Vivox;
using UnityEngine;

namespace VirtualMakerspace.Voice
{
    public sealed class VoiceChannelController : MonoBehaviour
    {
        public bool IsConnected { get; private set; }
        public string ChannelName { get; private set; } = string.Empty;

        public async Task ConnectAsync(string roomCode)
        {
            if (string.IsNullOrWhiteSpace(roomCode))
            {
                throw new ArgumentException("A room code is required.", nameof(roomCode));
            }

#if UNITY_ANDROID && !UNITY_EDITOR
            if (!UnityEngine.Android.Permission.HasUserAuthorizedPermission(UnityEngine.Android.Permission.Microphone))
            {
                UnityEngine.Android.Permission.RequestUserPermission(UnityEngine.Android.Permission.Microphone);
            }
#endif

            await UnityServices.InitializeAsync();
            if (!AuthenticationService.Instance.IsSignedIn)
            {
                await AuthenticationService.Instance.SignInAnonymouslyAsync();
            }

            await VivoxService.Instance.InitializeAsync();
            await VivoxService.Instance.LoginAsync();
            ChannelName = BuildChannelName(roomCode);
            await VivoxService.Instance.JoinGroupChannelAsync(ChannelName, ChatCapability.AudioOnly);
            IsConnected = true;
        }

        public static string BuildChannelName(string roomCode)
        {
            if (string.IsNullOrWhiteSpace(roomCode))
            {
                throw new ArgumentException("A room code is required.", nameof(roomCode));
            }

            return $"makerspace-{roomCode.Trim().ToLowerInvariant()}";
        }
    }
}