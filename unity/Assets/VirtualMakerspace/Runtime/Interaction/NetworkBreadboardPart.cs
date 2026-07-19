using System;
using Unity.Netcode;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit;
using UnityEngine.XR.Interaction.Toolkit.Interactables;

namespace VirtualMakerspace.Interaction
{
    [RequireComponent(typeof(NetworkObject))]
    [RequireComponent(typeof(XRGrabInteractable))]
    public sealed class NetworkBreadboardPart : NetworkBehaviour
    {
        private XRGrabInteractable _interactable;

        public NetworkVariable<int> SocketId { get; } = new NetworkVariable<int>(
            -1,
            NetworkVariableReadPermission.Everyone,
            NetworkVariableWritePermission.Server);

        public event Action<ulong, ulong> HandoffRecorded;

        private void Awake()
        {
            _interactable = GetComponent<XRGrabInteractable>();
        }

        private void OnEnable()
        {
            _interactable.selectEntered.AddListener(OnGrabbed);
        }

        private void OnDisable()
        {
            _interactable.selectEntered.RemoveListener(OnGrabbed);
        }

        public void RequestPlacement(int socketId, Vector3 position, Quaternion rotation)
        {
            int validSocketId = PlacementRules.RequireValidSocketId(socketId);
            if (IsSpawned)
            {
                RequestPlacementRpc(validSocketId, position, rotation);
                return;
            }

            ApplyPlacement(validSocketId, position, rotation);
        }

        private void OnGrabbed(SelectEnterEventArgs args)
        {
            if (IsSpawned)
            {
                RequestOwnershipRpc();
            }
        }

        [Rpc(SendTo.Server, InvokePermission = RpcInvokePermission.Everyone)]
        private void RequestOwnershipRpc(RpcParams rpcParams = default)
        {
            ulong requester = rpcParams.Receive.SenderClientId;
            ulong previousOwner = OwnerClientId;
            if (previousOwner == requester)
            {
                return;
            }

            NetworkObject.ChangeOwnership(requester);
            HandoffRecorded?.Invoke(previousOwner, requester);
            Debug.Log($"CPS handoff part={name} from={previousOwner} to={requester}");
        }

        [Rpc(SendTo.Server, InvokePermission = RpcInvokePermission.Everyone)]
        private void RequestPlacementRpc(int socketId, Vector3 position, Quaternion rotation)
        {
            ApplyPlacement(socketId, position, rotation);
            NetworkObject.RemoveOwnership();
        }

        private void ApplyPlacement(int socketId, Vector3 position, Quaternion rotation)
        {
            transform.SetPositionAndRotation(position, rotation);
            if (IsServer)
            {
                SocketId.Value = socketId;
            }
        }
    }
}