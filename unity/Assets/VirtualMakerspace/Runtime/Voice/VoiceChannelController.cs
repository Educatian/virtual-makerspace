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

            await EnsureMicrophonePermissionAsync();

            string requestedChannel = BuildChannelName(roomCode);
            if (IsConnected && string.Equals(ChannelName, requestedChannel, StringComparison.Ordinal))
            {
                return;
            }

            await UnityServices.InitializeAsync();
            if (!AuthenticationService.Instance.IsSignedIn)
            {
                await AuthenticationService.Instance.SignInAnonymouslyAsync();
            }

            await VivoxService.Instance.InitializeAsync();
            if (!VivoxService.Instance.IsLoggedIn)
            {
                await VivoxService.Instance.LoginAsync();
            }

            if (IsConnected)
            {
                await VivoxService.Instance.LeaveAllChannelsAsync();
                IsConnected = false;
            }

            ChannelName = requestedChannel;
            await VivoxService.Instance.JoinGroupChannelAsync(ChannelName, ChatCapability.AudioOnly);
            IsConnected = true;
            Debug.Log($"VM_ACCEPTANCE VOICE_CONNECTED channel={ChannelName} microphone=granted");
        }

        private static async Task EnsureMicrophonePermissionAsync()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            string permission = UnityEngine.Android.Permission.Microphone;
            if (UnityEngine.Android.Permission.HasUserAuthorizedPermission(permission))
            {
                return;
            }

            var completion = new TaskCompletionSource<bool>();
            var callbacks = new UnityEngine.Android.PermissionCallbacks();
            callbacks.PermissionGranted += _ => completion.TrySetResult(true);
            callbacks.PermissionDenied += _ => completion.TrySetResult(false);
            callbacks.PermissionDeniedAndDontAskAgain += _ => completion.TrySetResult(false);
            UnityEngine.Android.Permission.RequestUserPermission(permission, callbacks);

            if (!await completion.Task)
            {
                throw new UnauthorizedAccessException(
                    "Microphone permission is required for two-person voice communication.");
            }
#else
            await Task.CompletedTask;
#endif
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
