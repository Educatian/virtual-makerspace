#if UNITY_EDITOR
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Unity.Services.Authentication;
using Unity.Services.Core;
using Unity.Services.Multiplayer;
using Unity.Services.Vivox;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace VirtualMakerspace
{
    public static class CloudServiceSmokeVerifier
    {
        private const string PendingKey = "VirtualMakerspace.CloudSmoke.Pending";
        private static Task verificationTask;

        [InitializeOnLoadMethod]
        private static void Initialize()
        {
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
        }

        public static void Verify()
        {
            EditorSceneManager.OpenScene("Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity", OpenSceneMode.Single);
            UnityEditor.SessionState.SetBool(PendingKey, true);
            EditorApplication.isPlaying = true;
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state != PlayModeStateChange.EnteredPlayMode || !UnityEditor.SessionState.GetBool(PendingKey, false))
            {
                return;
            }

            UnityEditor.SessionState.SetBool(PendingKey, false);
            verificationTask = RunAsync();
            EditorApplication.update += Poll;
        }

        private static void Poll()
        {
            if (verificationTask == null || !verificationTask.IsCompleted)
            {
                return;
            }

            EditorApplication.update -= Poll;
            if (verificationTask.IsFaulted)
            {
                Debug.LogException(verificationTask.Exception);
                EditorApplication.Exit(1);
                return;
            }

            EditorApplication.Exit(0);
        }

        private static async Task RunAsync()
        {
            IHostSession session = null;
            bool authenticated = false;
            bool relaySessionCreated = false;
            bool vivoxLoggedIn = false;
            bool vivoxChannelJoined = false;
            string roomCode = string.Empty;
            string channelName = string.Empty;
            string error = string.Empty;

            try
            {
                await UnityServices.InitializeAsync();
                if (!AuthenticationService.Instance.IsSignedIn)
                {
                    await AuthenticationService.Instance.SignInAnonymouslyAsync();
                }

                authenticated = AuthenticationService.Instance.IsSignedIn;
                var options = new SessionOptions
                {
                    MaxPlayers = 2,
                    Name = "Virtual Makerspace Cloud Smoke Test",
                    IsPrivate = true
                }.WithRelayNetwork();

                session = await MultiplayerService.Instance.CreateSessionAsync(options);
                roomCode = session.Code;
                relaySessionCreated = !string.IsNullOrWhiteSpace(roomCode);

                await VivoxService.Instance.InitializeAsync();
                await VivoxService.Instance.LoginAsync();
                vivoxLoggedIn = VivoxService.Instance.IsLoggedIn;
                channelName = $"makerspace-smoke-{Guid.NewGuid():N}";
                await VivoxService.Instance.JoinGroupChannelAsync(channelName, ChatCapability.AudioOnly);
                vivoxChannelJoined = true;

                Debug.Log($"CLOUD_SMOKE_PASS auth={authenticated} relay={relaySessionCreated} vivoxLogin={vivoxLoggedIn} vivoxChannel={vivoxChannelJoined}");
            }
            catch (Exception exception)
            {
                error = exception.GetBaseException().Message;
                Debug.LogException(exception);
                throw;
            }
            finally
            {
                try
                {
                    if (vivoxChannelJoined)
                    {
                        await VivoxService.Instance.LeaveAllChannelsAsync();
                    }
                    if (vivoxLoggedIn)
                    {
                        await VivoxService.Instance.LogoutAsync();
                    }
                    if (session != null)
                    {
                        await session.DeleteAsync();
                    }
                }
                catch (Exception cleanupException)
                {
                    Debug.LogWarning($"Cloud smoke cleanup warning: {cleanupException.GetBaseException().Message}");
                }

                WriteResult(authenticated, relaySessionCreated, vivoxLoggedIn, vivoxChannelJoined, error);
            }
        }

        private static void WriteResult(bool authenticated, bool relay, bool vivoxLogin, bool vivoxChannel, string error)
        {
            string artifacts = Path.GetFullPath("Artifacts");
            Directory.CreateDirectory(artifacts);
            string escapedError = (error ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
            string json = new StringBuilder()
                .AppendLine("{")
                .AppendLine($"  \"timestampUtc\": \"{DateTime.UtcNow:O}\",")
                .AppendLine($"  \"authentication\": {authenticated.ToString().ToLowerInvariant()},")
                .AppendLine($"  \"relaySession\": {relay.ToString().ToLowerInvariant()},")
                .AppendLine($"  \"vivoxLogin\": {vivoxLogin.ToString().ToLowerInvariant()},")
                .AppendLine($"  \"vivoxChannel\": {vivoxChannel.ToString().ToLowerInvariant()},")
                .AppendLine($"  \"error\": \"{escapedError}\"")
                .AppendLine("}")
                .ToString();
            File.WriteAllText(Path.Combine(artifacts, "CloudServiceSmokeResult.json"), json);
        }
    }
}
#endif