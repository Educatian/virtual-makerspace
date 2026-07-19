using System;

namespace VirtualMakerspace.Interaction
{
    public static class PlacementRules
    {
        public const int MinimumSocketId = 0;
        public const int MaximumSocketId = 7;

        public static int RequireValidSocketId(int socketId)
        {
            if (socketId < MinimumSocketId || socketId > MaximumSocketId)
            {
                throw new ArgumentOutOfRangeException(nameof(socketId));
            }

            return socketId;
        }
    }
}