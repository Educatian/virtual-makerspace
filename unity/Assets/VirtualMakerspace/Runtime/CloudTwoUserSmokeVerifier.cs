#if UNITY_EDITOR
using System;
using System.IO;
using System.Threading.Tasks;
using Unity.Services.Authentication;
using Unity.Services.Core;
using Unity.Services.Multiplayer;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace VirtualMakerspace
{
    public static class CloudTwoUserSmokeVerifier
    {
        private const string PendingKey = "VirtualMakerspace.CloudTwoUserSmoke.Pending";
        private static Task verificationTask;

        [InitializeOnLoadMethod]
        private static void Initialize()
        {
            EditorApplication.playModeStateChanged -= OnPlayModeStateChanged;
            EditorApplication.playModeStateChanged += OnPlayModeStateChanged;
        }

        public static void Verify()
        {
            EditorSceneManager.OpenScene(
                "Assets/VirtualMakerspace/Scenes/MakerspacePrototype.unity",
                OpenSceneMode.Single);
            UnityEditor.SessionState.SetBool(PendingKey, true);
            EditorApplication.isPlaying = true;
        }

        private static void OnPlayModeStateChanged(PlayModeStateChange state)
        {
            if (state != PlayModeStateChange.EnteredPlayMode ||
                !UnityEditor.SessionState.GetBool(PendingKey, false))
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
            string suffix = Guid.NewGuid().ToString("N").Substring(0, 10);
            IUnityServices hostServices = UnityServices.CreateServices("vm-host-" + suffix);
            IUnityServices guestServices = UnityServices.CreateServices("vm-guest-" + suffix);
            IHostSession hostSession = null;
            ISession guestSession = null;
            string roomCode = string.Empty;
            string error = string.Empty;
            bool passed = false;

            try
            {
                await hostServices.InitializeAsync(new InitializationOptions());
                await guestServices.InitializeAsync(new InitializationOptions());

                IAuthenticationService hostAuth = hostServices.GetAuthenticationService();
                IAuthenticationService guestAuth = guestServices.GetAuthenticationService();
                hostAuth.SwitchProfile("host-" + suffix);
                guestAuth.SwitchProfile("guest-" + suffix);
                await hostAuth.SignInAnonymouslyAsync();
                await guestAuth.SignInAnonymouslyAsync();

                var options = new SessionOptions
                {
                    MaxPlayers = 2,
                    Name = "Virtual Makerspace Two User Smoke",
                    IsPrivate = true
                };

                hostSession = await hostServices.GetMultiplayerService().CreateSessionAsync(options);
                roomCode = hostSession.Code;
                guestSession = await guestServices.GetMultiplayerService().JoinSessionByCodeAsync(roomCode);

                passed = guestSession.PlayerCount == 2 &&
                    string.Equals(hostSession.Code, guestSession.Code, StringComparison.Ordinal);
                if (!passed)
                {
                    throw new InvalidOperationException(
                        $"Two-user session did not converge: host={hostSession.PlayerCount}, guest={guestSession.PlayerCount}");
                }

                Debug.Log($"CLOUD_TWO_USER_PASS room={roomCode} host={hostSession.PlayerCount} guest={guestSession.PlayerCount}");
            }
            catch (Exception exception)
            {
                error = exception.GetBaseException().Message;
                throw;
            }
            finally
            {
                try
                {
                    if (guestSession != null)
                    {
                        await guestSession.LeaveAsync();
                    }
                    if (hostSession != null)
                    {
                        await hostSession.DeleteAsync();
                    }
                }
                catch (Exception cleanupException)
                {
                    Debug.LogWarning("Two-user smoke cleanup warning: " + cleanupException.GetBaseException().Message);
                }

                string artifacts = Path.GetFullPath("Artifacts");
                Directory.CreateDirectory(artifacts);
                string json = "{\n" +
                    $"  \"timestampUtc\": \"{DateTime.UtcNow:O}\",\n" +
                    $"  \"passed\": {passed.ToString().ToLowerInvariant()},\n" +
                    $"  \"roomCode\": \"{roomCode}\",\n" +
                    $"  \"error\": \"{Escape(error)}\"\n" +
                    "}\n";
                File.WriteAllText(Path.Combine(artifacts, "CloudTwoUserSmokeResult.json"), json);
            }
        }

        private static string Escape(string value)
        {
            return (value ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"")
                .Replace("\r", " ").Replace("\n", " ");
        }
    }
}
#endif
