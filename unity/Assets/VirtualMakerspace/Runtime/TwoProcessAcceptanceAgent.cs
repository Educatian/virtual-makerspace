using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using Unity.Netcode;
using UnityEngine;
using VirtualMakerspace.Sessions;

namespace VirtualMakerspace
{
    /// <summary>
    /// Dormant in normal builds. When launched with -vmAcceptanceRole host|guest,
    /// drives a real two-process Relay, Netcode, and Vivox acceptance check.
    /// </summary>
    public sealed class TwoProcessAcceptanceAgent : MonoBehaviour
    {
        private const int TimeoutSeconds = 90;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void InstallWhenRequested()
        {
            if (ReadArgument("-vmAcceptanceRole") == null)
            {
                return;
            }

            var root = new GameObject("Two Process Acceptance Agent");
            DontDestroyOnLoad(root);
            root.AddComponent<TwoProcessAcceptanceAgent>();
        }

        private async void Start()
        {
            string role = ReadArgument("-vmAcceptanceRole")?.ToLowerInvariant();
            string outputDirectory = Environment.GetEnvironmentVariable("VM_ACCEPTANCE_DIR");
            if (string.IsNullOrWhiteSpace(outputDirectory))
            {
                outputDirectory = Path.Combine(Application.persistentDataPath, "TwoProcessAcceptance");
            }

            Directory.CreateDirectory(outputDirectory);
            string roomCode = string.Empty;
            string error = string.Empty;
            bool passed = false;
            MultiplayerSessionController session = FindAnyObjectByType<MultiplayerSessionController>();

            try
            {
                if (session == null)
                {
                    throw new InvalidOperationException("MultiplayerSessionController was not found in the release scene.");
                }

                if (role == "host")
                {
                    roomCode = await session.CreateRoomAsync();
                    File.WriteAllText(Path.Combine(outputDirectory, "room-code.txt"), roomCode);
                }
                else if (role == "guest")
                {
                    string codePath = Path.Combine(outputDirectory, "room-code.txt");
                    await WaitUntilAsync(() => File.Exists(codePath), "Host did not publish a room code.");
                    roomCode = File.ReadAllText(codePath).Trim();
                    await session.JoinRoomAsync(roomCode);
                }
                else
                {
                    throw new ArgumentException("-vmAcceptanceRole must be host or guest.");
                }

                await WaitUntilAsync(() => HasExpectedNetworkState(role, session),
                    $"{role} did not reach the two-user Relay/Netcode state.");
                await WaitUntilAsync(() => session.IsVoiceConnected,
                    $"{role} did not join the Vivox audio channel.");

                passed = session.ParticipantCount == 2 && session.IsConnected && session.IsVoiceConnected;
                if (!passed)
                {
                    throw new InvalidOperationException("Acceptance invariants were not all satisfied.");
                }
            }
            catch (Exception exception)
            {
                error = exception.GetBaseException().Message;
                UnityEngine.Debug.LogException(exception);
            }
            finally
            {
                WriteResult(outputDirectory, role, roomCode, session, passed, error);
                if (role == "host" && passed)
                {
                    try
                    {
                        await WaitUntilAsync(
                            () => File.Exists(Path.Combine(outputDirectory, "guest-result.json")),
                            "Guest did not finish before the host shutdown gate.");
                    }
                    catch (Exception exception)
                    {
                        UnityEngine.Debug.LogWarning(exception.GetBaseException().Message);
                    }
                }

                await Task.Delay(1500);
                Application.Quit(passed ? 0 : 1);
            }
        }

        private static bool HasExpectedNetworkState(string role, MultiplayerSessionController session)
        {
            NetworkManager network = NetworkManager.Singleton;
            if (network == null || !network.IsListening || session.ParticipantCount != 2 || !session.IsConnected)
            {
                return false;
            }

            return role == "host"
                ? network.IsHost && network.ConnectedClientsIds.Count == 2
                : network.IsClient && network.IsConnectedClient;
        }

        private static async Task WaitUntilAsync(Func<bool> predicate, string timeoutMessage)
        {
            var timer = Stopwatch.StartNew();
            while (!predicate())
            {
                if (timer.Elapsed.TotalSeconds >= TimeoutSeconds)
                {
                    throw new TimeoutException(timeoutMessage);
                }

                await Task.Delay(200);
            }
        }

        private static void WriteResult(string directory, string role, string code,
            MultiplayerSessionController session, bool passed, string error)
        {
            NetworkManager network = NetworkManager.Singleton;
            int connectedClients = network != null && network.IsHost ? network.ConnectedClientsIds.Count :
                network != null && network.IsConnectedClient ? 1 : 0;
            string json = "{\n" +
                $"  \"timestampUtc\": \"{DateTime.UtcNow:O}\",\n" +
                $"  \"role\": \"{Escape(role)}\",\n" +
                $"  \"passed\": {passed.ToString().ToLowerInvariant()},\n" +
                $"  \"roomCode\": \"{Escape(code)}\",\n" +
                $"  \"sessionConnected\": {(session != null && session.IsConnected).ToString().ToLowerInvariant()},\n" +
                $"  \"participantCount\": {session?.ParticipantCount ?? 0},\n" +
                $"  \"voiceConnected\": {(session != null && session.IsVoiceConnected).ToString().ToLowerInvariant()},\n" +
                $"  \"networkListening\": {(network != null && network.IsListening).ToString().ToLowerInvariant()},\n" +
                $"  \"connectedClients\": {connectedClients},\n" +
                $"  \"error\": \"{Escape(error)}\"\n" +
                "}\n";
            File.WriteAllText(Path.Combine(directory, $"{role}-result.json"), json);
        }

        private static string ReadArgument(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            int index = Array.FindIndex(args, item => string.Equals(item, name, StringComparison.OrdinalIgnoreCase));
            return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
        }

        private static string Escape(string value)
        {
            return (value ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"")
                .Replace("\r", " ").Replace("\n", " ");
        }
    }
}
