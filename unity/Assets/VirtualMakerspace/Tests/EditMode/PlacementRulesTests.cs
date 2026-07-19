using System;
using NUnit.Framework;
using VirtualMakerspace.Interaction;

namespace VirtualMakerspace.Tests
{
    public sealed class PlacementRulesTests
    {
        [TestCase(0)]
        [TestCase(7)]
        public void RequireValidSocketId_ReturnsId_WhenInsideBreadboardRange(int socketId)
        {
            // Given / When
            int result = PlacementRules.RequireValidSocketId(socketId);

            // Then
            Assert.That(result, Is.EqualTo(socketId));
        }

        [TestCase(-1)]
        [TestCase(8)]
        public void RequireValidSocketId_Throws_WhenOutsideBreadboardRange(int socketId)
        {
            // Given / When / Then
            Assert.Throws<ArgumentOutOfRangeException>(() => PlacementRules.RequireValidSocketId(socketId));
        }
    }
}