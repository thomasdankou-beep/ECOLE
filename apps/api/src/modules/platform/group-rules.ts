import { BadRequestException } from '@nestjs/common';

/** Une facture de groupe est dans une seule monnaie : toutes les écoles d'un groupe comptent dans la même (lot G1). */
export function checkSameCurrency(members: { currency: string }[], currency: string) {
  const other = members.find((m) => m.currency !== currency);
  if (other) throw new BadRequestException(`Les écoles de ce groupe comptent en ${other.currency}, celle-ci en ${currency} : une facture de groupe est dans une seule monnaie`);
}
